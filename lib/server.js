/**
 * dsh-workbuddy 的 HTTP 面 —— 面板就是靠这几个端点活的。
 *
 * 全部挂在 DSH 自己的 webServer 上（和 dsh-purge / dsh-worktable 一个待遇），
 * 所以浏览器端只用 fetch 相对路径，不需要额外端口、不需要跨域配置。
 *
 *   GET  /dsh-workbuddy/state    → { app:{running,port,reason}, models, agents, jobs[], running }
 *   POST /dsh-workbuddy/submit   → { jobId }            body: { prompt, agent, model, system, maxTurns, timeoutSec }
 *   POST /dsh-workbuddy/cancel   → { ok }               body: { jobId }
 *   POST /dsh-workbuddy/clear    → { ok }               清空账本
 *   GET  /dsh-workbuddy/probe    → 通道诊断（真去敲一次网关探针）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { status as channelStatus } from './gateway.js'

const PANEL_HTML = join(dirname(fileURLToPath(import.meta.url)), '..', 'panel', 'panel.html')
const PANEL_BRAND_ICONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'panel', 'brand-icons.js')
const ICON_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'workbuddy', 'icons')
const ICON_ORIGIN = 'https://download.codebuddy.cn/model-icon/'

function sendJson(response, code, value) {
  const body = JSON.stringify(value)
  response.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  response.end(body)
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let raw = ''
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > 4 * 1024 * 1024) {
        reject(new Error('请求体太大'))
        request.destroy()
        return
      }
      raw += chunk.toString('utf8')
    })
    request.on('end', () => {
      if (!raw.trim()) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new Error(`JSON 解析失败：${error.message}`))
      }
    })
    request.on('error', reject)
  })
}

const PROBE_TTL_MS = 8000

/**
 * 装路由。
 * @param {object} host - 带 webServer 的宿主上下文
 * @param {object} runtime - createRuntime() 的返回值
 * @param {object} config - 插件配置
 * @returns {Array<() => void>} disposer 列表
 */
export function installRoutes(host, runtime, config = {}) {
  const disposers = []
  let lastProbe = { at: 0, value: null }

  const register = (path, handler, label) => {
    const dispose = host.webServer.register({ kind: 'exact', path, handler }, `dsh-workbuddy: ${label}`)
    if (typeof dispose === 'function') disposers.push(dispose)
  }

  /** App 在不在跑：探针有缓存，面板 1 秒一次的轮询不会把 WorkBuddy 敲出火星。 */
  const appStatus = async (force = false) => {
    const now = Date.now()
    if (!force && lastProbe.value && now - lastProbe.at < PROBE_TTL_MS) return lastProbe.value
    let value
    try {
      const s = await channelStatus(config)
      const usable = (s.candidates ?? [])
        .flatMap((c) => (c.ports ?? []).filter((p) => p.ok).map((p) => ({ pid: c.pid, port: p.port })))
      value = {
        running: Boolean(s.running),
        gateway: Boolean(s.gateway),
        reason: s.reason ?? '',
        endpoints: usable,
        port: usable[0]?.port ?? null,
      }
    } catch (error) {
      value = { running: false, gateway: false, reason: String(error?.message ?? error), endpoints: [], port: null }
    }
    lastProbe = { at: now, value }
    return value
  }

  register('/dsh-workbuddy/state', async (request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET' })
      response.end()
      return
    }
    const app = await appStatus()
    const snap = runtime.snapshot()
    sendJson(response, 200, { ok: true, app, ...snap, ts: Date.now() })
  }, 'state')

  register('/dsh-workbuddy/probe', async (request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET' })
      response.end()
      return
    }
    const app = await appStatus(true)
    sendJson(response, 200, { ok: app.gateway, app })
  }, 'probe')

  register('/dsh-workbuddy/submit', async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    try {
      const body = await readJsonBody(request)
      const prompt = String(body?.prompt ?? '').trim()
      if (!prompt) {
        sendJson(response, 400, { ok: false, error: 'prompt 不能为空' })
        return
      }
      const app = await appStatus(true)
      if (!app.gateway) {
        sendJson(response, 503, {
          ok: false,
          error: app.running
            ? 'WorkBuddy 在跑，但网关还没热起来（预热进程刚被回收或刚重启）。在 WorkBuddy 里随便发一句话，几秒后点面板上的「重试」。'
            : 'WorkBuddy 没在运行。先打开 WorkBuddy 桌面端，再派活。',
          app,
          retryable: true,
        })
        return
      }
      const { id } = runtime.submit({
        source: 'panel',
        prompt,
        agent: body?.agent,
        model: body?.model,
        system: body?.system,
        maxTurns: Number(body?.maxTurns) || undefined,
        timeoutSec: Number(body?.timeoutSec) || undefined,
        gearLabel: body?.gearLabel,
        skill: body?.skill,
        fullAccess: body?.access === 'full',
      })
      sendJson(response, 200, { ok: true, jobId: id })
    } catch (error) {
      sendJson(response, 400, { ok: false, error: String(error?.message ?? error) })
    }
  }, 'submit')

  register('/dsh-workbuddy/cancel', async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    try {
      const body = await readJsonBody(request)
      const id = String(body?.jobId ?? '')
      const ok = id ? runtime.cancel(id) : false
      sendJson(response, ok ? 200 : 404, { ok, jobId: id })
    } catch (error) {
      sendJson(response, 400, { ok: false, error: String(error?.message ?? error) })
    }
  }, 'cancel')

  register('/dsh-workbuddy/clear', async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    runtime.clearHistory()
    sendJson(response, 200, { ok: true })
  }, 'clear')

  register('/dsh-workbuddy/brand-icons.js', async (request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET' })
      response.end()
      return
    }
    // 从 WorkBuddy 的 app.asar 里抽出来的原版品牌图标（DeepSeekIcon / GLMIcon / KimiIcon …）
    let js
    try {
      js = readFileSync(PANEL_BRAND_ICONS, 'utf8')
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end(`brand-icons.js 读不出来：${String(error?.message ?? error)}`)
      return
    }
    response.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(js),
    })
    response.end(js)
  }, 'brand-icons')

  register('/dsh-workbuddy/icon', async (request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET' })
      response.end()
      return
    }
    // 原版图标：/dsh-workbuddy/icon?f=wb-fast.svg —— 首次下载后落盘，之后只读本地
    let name = ''
    try {
      name = new URL(request.url, 'http://127.0.0.1').searchParams.get('f') || ''
    } catch {
      name = ''
    }
    if (!/^[A-Za-z0-9._-]+\.svg$/i.test(name) || name.includes('..')) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('bad icon name')
      return
    }
    const local = join(ICON_DIR, name)
    let svg = null
    try {
      if (existsSync(local)) svg = readFileSync(local)
    } catch {
      svg = null
    }
    if (!svg) {
      try {
        const upstream = await fetch(ICON_ORIGIN + name, { signal: AbortSignal.timeout(8000) })
        if (upstream.ok) {
          svg = Buffer.from(await upstream.arrayBuffer())
          try {
            mkdirSync(ICON_DIR, { recursive: true })
            writeFileSync(local, svg)
          } catch { /* 缓存失败不影响本次返回 */ }
        }
      } catch {
        svg = null
      }
    }
    if (!svg) {
      // 拿不到就回一个透明 SVG，别让面板出破图
      response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' })
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"></svg>')
      return
    }
    response.writeHead(200, {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=86400',
      'Content-Length': svg.length,
    })
    response.end(svg)
  }, 'icon')

  register('/dsh-workbuddy/panel', async (request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET' })
      response.end()
      return
    }
    // 每次请求都读盘：面板 UI 的迭代不需要重启 dsh
    let html
    try {
      html = readFileSync(PANEL_HTML, 'utf8')
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end(`panel.html 读不出来：${String(error?.message ?? error)}`)
      return
    }
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, must-revalidate',
      'Content-Length': Buffer.byteLength(html),
    })
    response.end(html)
  }, 'panel')

  return disposers
}
