/**
 * dsh-workbuddy —— WorkBuddy 网关（纯逻辑，宿主与命令行共用）
 *
 * WorkBuddy 桌面版（腾讯 CodeBuddy）在运行时会把一个已认证的 codebuddy CLI
 * 预热进程挂成本机 HTTP 网关：
 *   POST http://127.0.0.1:<prewarm 端口>/api/v1/llm/completions
 *   Authorization: Bearer <CODEBUDDY_GATEWAY_PASSWORD>
 * 请求体 { userPrompt, agentName?, systemPrompt?, model?, maxTurns?, bypassPermissions? }
 * 响应   { text, success }
 *
 * 端口与密码都不写死：每次从预热进程的环境块里现场读（discover.ps1），
 * 因此 App 重启、换端口、换密码都不影响。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const DISCOVER_SCRIPT = join(PLUGIN_DIR, 'discover.ps1')

/** 端点缓存：{ at, endpoint } —— 命中后 90 秒内复用，避免每次调用都读进程内存。 */
let cache = { at: 0, endpoint: null }
const CACHE_TTL_MS = 90_000

const DEFAULT_AGENT = 'general-purpose'
const PROBE_PATH = '/api/v1/stats'
const CHAT_PATH = '/api/v1/llm/completions'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 清掉端点缓存，下一次必须重新发现。 */
function invalidate() {
  cache = { at: 0, endpoint: null }
}

/** 这些错误属于「通道状态变了」，值得重探一次再试；其他错误直接抛。 */
function isChannelError(message) {
  return /连不上|401|拒绝|ECONN|ENOTFOUND|fetch failed|socket|预热|未运行/i.test(String(message || ''))
}

function powershellPath() {
  const windir = process.env.SystemRoot ?? 'C:\\Windows'
  const full = join(windir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(full) ? full : 'powershell.exe'
}

/** 跑 discover.ps1，拿回预热进程的 {pid, port, password} 候选。 */
function runDiscover(timeoutMs = 45_000) {
  return new Promise((resolve) => {
    if (!existsSync(DISCOVER_SCRIPT)) {
      resolve({ ok: false, reason: 'discover-script-missing', candidates: [] })
      return
    }

    let child
    try {
      child = spawn(
        powershellPath(),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', DISCOVER_SCRIPT],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      )
    } catch (error) {
      resolve({ ok: false, reason: `spawn-failed: ${error.message}`, candidates: [] })
      return
    }

    let out = ''
    let err = ''
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      done({ ok: false, reason: 'discover-timeout', candidates: [] })
    }, timeoutMs)

    child.stdout?.on('data', (d) => { out += d.toString() })
    child.stderr?.on('data', (d) => { err += d.toString() })
    child.on('error', (e) => done({ ok: false, reason: `spawn-failed: ${e.message}`, candidates: [] }))
    child.on('close', () => {
      const text = out.trim()
      const start = text.indexOf('{')
      if (start < 0) {
        done({ ok: false, reason: `discover-empty${err ? `: ${err.slice(0, 200)}` : ''}`, candidates: [] })
        return
      }
      try {
        done(JSON.parse(text.slice(start)))
      } catch (e) {
        done({ ok: false, reason: `discover-bad-json: ${String(e?.message ?? e)}`, candidates: [] })
      }
    })
  })
}

/** 带 Bearer 的探针请求：200/2xx 才认这是 WorkBuddy 网关（401 = 密码不对，404 = 不是它）。 */
async function probe(port, password, timeoutMs = 5000) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${PROBE_PATH}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${password}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    return { ok: res.ok, status: res.status }
  } catch (error) {
    return { ok: false, status: 0, error: String(error?.message ?? error) }
  }
}

/**
 * 解析出可用的网关端点。
 * 顺序：显式配置 → 缓存 → 现场发现（读预热进程环境 + 逐端口探针）。
 */
export async function resolveEndpoint(config = {}, { force = false } = {}) {
  if (config.port && config.password) {
    const hit = await probe(config.port, config.password)
    if (hit.ok) return { port: Number(config.port), password: config.password, source: 'config' }
    throw new Error(
      `配置里的网关不可用（${config.port} 返回 ${hit.status}）。` +
      '检查 WorkBuddy 是否在运行，或从配置中删掉 port/password 让插件自动发现。',
    )
  }

  const now = Date.now()
  if (!force && cache.endpoint && now - cache.at < CACHE_TTL_MS) {
    const hit = await probe(cache.endpoint.port, cache.endpoint.password, 2500)
    if (hit.ok) return { ...cache.endpoint, source: 'cache' }
  }

  let found = await runDiscover()
  // WorkBuddy 刚启动 / 刚被唤醒时，预热进程可能几秒后才出来：等一下再发现一次
  if (!found.ok && (found.reason === 'prewarm-credentials-unavailable' || found.reason === 'workbuddy-not-running')) {
    await sleep(900)
    found = await runDiscover()
  }
  if (!found.ok) throw new Error(explainDiscoverFailure(found.reason))
  return pickEndpoint(found)
}

/** 在候选里挑出真正能应答的端口。 */
async function pickEndpoint(found) {
  for (const candidate of found.candidates ?? []) {
    for (const port of candidate.ports ?? []) {
      const hit = await probe(port, candidate.password)
      if (hit.ok) {
        const endpoint = { port: Number(port), password: candidate.password }
        cache = { at: Date.now(), endpoint }
        return { ...endpoint, pid: candidate.pid, source: 'discover' }
      }
    }
  }

  const ports = (found.candidates ?? []).flatMap((c) => c.ports ?? [])
  throw new Error(
    '找到了 WorkBuddy 预热进程，但它的 HTTP 网关没有被任何端口接受。' +
    `已尝试端口：${ports.length ? ports.join(', ') : '（无监听端口）'}。` +
    '在 WorkBuddy 里随便发一条消息让预热进程激活，然后再试。',
  )
}

function explainDiscoverFailure(reason) {
  switch (reason) {
    case 'workbuddy-not-running':
      return 'WorkBuddy 没在运行。先打开 WorkBuddy 桌面端（它会自动拉起预热 CLI 进程），然后再调用。'
    case 'prewarm-credentials-unavailable':
      return 'WorkBuddy 在运行，但读不到预热进程的网关凭据（可能刚启动还在预热）。等几秒再试。'
    case 'discover-timeout':
      return '读取 WorkBuddy 进程信息超时。稍后重试。'
    default:
      return `端点发现失败：${reason}`
  }
}

/** 发一次任务给 WorkBuddy；通道类失败自动重探并重试一次。 */
export async function complete(prompt, options = {}, config = {}) {
  try {
    return await completeOnce(prompt, options, config)
  } catch (error) {
    const message = String(error?.message ?? error)
    if (!isChannelError(message) || options.signal?.aborted) throw error
    // App 重启换了端口/密码，或者预热进程刚被回收：清缓存，重探，再来一次
    invalidate()
    await sleep(700)
    return completeOnce(prompt, options, { ...config })
  }
}

/** 单次实现。 */
async function completeOnce(prompt, options = {}, config = {}) {
  const endpoint = await resolveEndpoint(config)
  const payload = {
    userPrompt: String(prompt ?? ''),
    // 服务端不给 agentName 时默认丢给 'pulse'（只有联网搜索，没有文件/shell）。
    // 我们要的是能干活的那个，所以显式指定。
    agentName: String(options.agent || DEFAULT_AGENT),
  }
  if (options.system) payload.systemPrompt = String(options.system)
  if (options.model) payload.model = String(options.model)
  if (Number.isFinite(options.maxTurns) && options.maxTurns > 0) payload.maxTurns = Number(options.maxTurns)
  if (options.fullAccess === true) payload.bypassPermissions = true

  const timeoutMs = Number.isFinite(options.timeoutSec) && options.timeoutSec > 0
    ? Math.min(options.timeoutSec, 3600) * 1000
    : 600_000

  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  // 外部的取消信号（面板上的"停止"）和超时信号合并成一个
  const signal = options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal

  let res
  try {
    res = await fetch(`http://127.0.0.1:${endpoint.port}${CHAT_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${endpoint.password}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(payload),
      signal,
    })
  } catch (error) {
    // 端点可能刚好被 App 回收：清缓存，提示一次重试
    cache = { at: 0, endpoint: null }
    const msg = String(error?.message ?? error)
    if (options.signal?.aborted) throw new Error('已取消。')
    if (/abort|timeout/i.test(msg)) throw new Error(`WorkBuddy 在 ${Math.round(timeoutMs / 1000)} 秒内没有返回。把 timeoutSec 调大，或把任务拆小。`)
    throw new Error(`连不上 WorkBuddy 网关（${endpoint.port}）：${msg}。它可能刚重启，重试一次。`)
  }

  const raw = await res.text()
  if (res.status === 401) {
    cache = { at: 0, endpoint: null }
    throw new Error('WorkBuddy 网关拒绝了这个凭据（401）。App 可能刚重启换了密码，重试一次；仍失败就用 workbuddy_probe 看状态。')
  }
  if (!res.ok) {
    throw new Error(`WorkBuddy 返回 HTTP ${res.status}：${raw.slice(0, 400)}`)
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 少数情况网关直接回纯文本
    return { text: raw.trim(), success: true, endpoint }
  }

  if (parsed?.success === false) {
    const detail = parsed?.error || parsed?.code || 'unknown'
    throw new Error(`WorkBuddy 拒绝了这次任务：${detail}`)
  }
  return { text: String(parsed?.text ?? '').trim(), success: true, endpoint, raw: parsed }
}

/** 诊断用：App 在不在、网关在哪个端口、探针回什么。 */
export async function status(config = {}) {
  const found = await runDiscover()
  if (!found.ok) {
    // 区分「App 在跑但预热进程被回收」和「App 压根没开」——两者的提示文案完全不同
    const appAlive = found.reason === 'prewarm-credentials-unavailable'
    return { running: appAlive, gateway: false, reason: explainDiscoverFailure(found.reason), candidates: [] }
  }
  const candidates = []
  for (const candidate of found.candidates ?? []) {
    const ports = []
    for (const port of candidate.ports ?? []) {
      const hit = await probe(port, candidate.password)
      ports.push({ port: Number(port), ok: hit.ok, status: hit.status })
    }
    candidates.push({ pid: candidate.pid, ports })
  }
  return {
    running: true,
    gateway: candidates.some((c) => c.ports.some((p) => p.ok)),
    candidates,
  }
}

export const DEFAULTS = { agent: DEFAULT_AGENT, chatPath: CHAT_PATH }
