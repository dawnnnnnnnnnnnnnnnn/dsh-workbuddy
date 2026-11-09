/**
 * dsh-workbuddy 任务运行时 —— 面板与工具共用的那张账本。
 *
 * 一个 job = 一次派活。工具调用（模型派活）和面板手点派活都写进同一张表，
 * 所以面板上看到的就是"我们之间的全部交接"：谁派的、用什么模型、多长时间、
 * 交回了什么。带并发（多任务同时跑）、可取消、落盘成 JSONL 供重启后回看。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { complete } from './gateway.js'

const MAX_JOBS = 300

/**
 * 模型 / 角色清单不硬编码：直接读 WorkBuddy 自己的产品配置
 * （~/.workbuddy/storage/user-＋/scoped/＋/wb-product-config.json）。
 * 那份配置里 models[] 的 id 就是网关认的 model 值，credits 是倍率，
 * tag:['craft'] 是订阅优先，x0.00 是限时免费，modelPromotions 是折扣角标。
 */
const WB_HOME = process.env.WORKBUDDY_CONFIG_DIR || join(homedir(), '.workbuddy')
let catalogCache = { at: 0, value: null }
const CATALOG_TTL_MS = 60_000

function findProductConfig() {
  const base = join(WB_HOME, 'storage')
  if (!existsSync(base)) return null
  let best = null
  let bestTime = 0
  try {
    for (const user of readdirSync(base)) {
      if (!user.startsWith('user-')) continue
      const scoped = join(base, user, 'scoped')
      if (!existsSync(scoped)) continue
      for (const bucket of readdirSync(scoped)) {
        const file = join(scoped, bucket, 'wb-product-config.json')
        if (!existsSync(file)) continue
        const time = statSync(file).mtimeMs
        if (time > bestTime) {
          bestTime = time
          best = file
        }
      }
    }
  } catch {
    return null
  }
  return best
}

/** 把原始 models[] 折成 UI 要的那一份：去重同名、按原版顺序、算角标。 */
function normalizeCatalog(data) {
  const tiers = Array.isArray(data.modelTiers) ? data.modelTiers : []
  const tierIds = new Set(tiers.flatMap((t) => t.modelIds || []))

  // 角标直接来自 modelPromotions（原版就是这么标的）：限时免费 / 夜间折扣 / 限时折扣
  const promoMap = new Map()
  for (const p of Array.isArray(data.modelPromotions) ? data.modelPromotions : []) {
    if (!p || p.enabled === false) continue
    const label = (p.badge && p.badge.label) || ''
    if (!label) continue
    for (const id of p.modelIds || (p.modelId ? [p.modelId] : [])) promoMap.set(id, label)
  }

  const seen = new Set()
  const all = []
  for (const m of Array.isArray(data.models) ? data.models : []) {
    if (!m || !m.id) continue
    // 同名变体（hy3 / hy3-b / hy3-c）只留第一个，跟原版下拉一样
    const key = (m.name || m.id).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    const credits = String(m.credits || '').replace(/^x/i, '')
    // 没有倍率的不是下拉里的可选项：Claude-3.7/4.0（default-1.x 内部别名）、
    // codewise-* 编辑器补全、hunyuan-image / kling-video 这类生成模型，都不该出现在派活下拉里。
    if (!credits) continue

    let badge = promoMap.get(m.id) || ''
    if (!badge && tierIds.has(m.id)) badge = '订阅优先'
    if (!badge && Array.isArray(m.tag) && m.tag.includes('craft')) badge = '订阅优先'

    // 图标用原版自己的：内联 data URI 原样带过去，远程 SVG 交给 /dsh-workbuddy/icon 代理缓存。
    const url = String(m.iconUrl || '')
    let icon = ''
    if (url.startsWith('data:')) icon = url
    else if (/^https?:\/\//i.test(url)) icon = '/dsh-workbuddy/icon?f=' + encodeURIComponent(url.split('/').pop())

    all.push({
      id: m.id,
      name: m.name || m.id,
      credits,
      badge,
      icon,
      vendor: m.vendor || '',
      isDefault: Boolean(m.isDefault),
      desc: m.descriptionZh || '',
      toolCall: m.supportsToolCall !== false,
      images: Boolean(m.supportsImages),
    })
  }

  // 原版下拉的固定头部顺序（其余按配置原序跟在后面）
  const PIN = ['fast-model', 'balanced-model', 'deep-model', 'hy4free', 'hy3', 'deepseek-v4.1-flash', 'glm-5.3', 'glm-5.3-flash', 'glm-5.2']
  const pinned = PIN.map((id) => all.find((m) => m.id === id)).filter(Boolean)
  const pinnedIds = new Set(pinned.map((m) => m.id))
  const models = [...pinned, ...all.filter((m) => !pinnedIds.has(m.id))]

  const available = new Set((Array.isArray(data.agents) ? data.agents : []).map((a) => a && a.name).filter(Boolean))
  // 面板只暴露「权限」这一维：能干活的 general-purpose 放第一，其余按可读性排序；cli 这类内部 agent 不列。
  const agents = ['general-purpose', 'pulse', 'Explore', 'Plan'].filter((n) => available.has(n))

  return {
    models,
    agents: agents.length ? agents : ['general-purpose', 'pulse'],
    tiers,
  }
}

export function loadCatalog() {
  const now = Date.now()
  if (catalogCache.value && now - catalogCache.at < CATALOG_TTL_MS) return catalogCache.value
  let value = null
  const file = findProductConfig()
  if (file) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      const data = raw['product-config-snapshot']?.data ?? raw.data ?? raw
      if (data && Array.isArray(data.models) && data.models.length) value = normalizeCatalog(data)
    } catch {
      value = null
    }
  }
  if (!value) value = { models: FALLBACK_MODELS, agents: FALLBACK_AGENTS, tiers: [] }
  catalogCache = { at: now, value }
  return value
}

/** 读不到 WorkBuddy 配置时的兜底（就是原版那三个 + 几个常用的）。 */
const FALLBACK_MODELS = [
  { id: 'fast-model', name: '快速', credits: '0.15', badge: '', isDefault: true, desc: '优先响应速度，适合简单任务与快速问答' },
  { id: 'balanced-model', name: '均衡', credits: '0.50', badge: '', isDefault: false, desc: '兼顾速度与质量，适合大多数日常工作' },
  { id: 'deep-model', name: '极致', credits: '1.00', badge: '', isDefault: false, desc: '优先深度与准确性，适合复杂分析和高要求任务' },
]
const FALLBACK_AGENTS = ['general-purpose', 'pulse']

/**
 * WorkBuddy 的技能清单：用户装的在 ~/.workbuddy/skills，
 * 内置的在 App 安装目录下的 builtin skills。
 * 安装目录优先取 WORKBUDDY_INSTALL_DIR，其次按标准位置探测（不写死任何具体盘符）。
 */
const BUILTIN_SKILL_CANDIDATES = [
  process.env.CODEBUDDY_BUILTIN_SKILLS_DIR || '',
  process.env.WORKBUDDY_INSTALL_DIR
    ? join(process.env.WORKBUDDY_INSTALL_DIR, 'resources/app.asar.unpacked/resources/plugins/workbuddy-builtin/skills')
    : '',
  `${process.env.ProgramFiles || 'C:/Program Files'}/WorkBuddy/resources/app.asar.unpacked/resources/plugins/workbuddy-builtin/skills`,
  `${process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)'}/WorkBuddy/resources/app.asar.unpacked/resources/plugins/workbuddy-builtin/skills`,
  `${process.env.LOCALAPPDATA || ''}/Programs/WorkBuddy/resources/app.asar.unpacked/resources/plugins/workbuddy-builtin/skills`,
].filter(Boolean)

const SKILL_DIRS = [join(WB_HOME, 'skills'), ...BUILTIN_SKILL_CANDIDATES.filter((d) => existsSync(d))]

let skillCache = { at: 0, value: null }

export function loadSkills() {
  const now = Date.now()
  if (skillCache.value && now - skillCache.at < 60_000) return skillCache.value
  const seen = new Set()
  const out = []
  for (const dir of SKILL_DIRS) {
    if (!existsSync(dir)) continue
    let names = []
    try {
      names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    } catch {
      continue
    }
    for (const dirName of names) {
      if (seen.has(dirName)) continue
      const file = join(dir, dirName, 'SKILL.md')
      if (!existsSync(file)) continue
      seen.add(dirName)
      let title = dirName
      let desc = ''
      try {
        const head = readFileSync(file, 'utf8').slice(0, 1200)
        const t = /^name:\s*(.+)$/m.exec(head)
        const d = /^description:\s*(.+)$/m.exec(head)
        if (t) title = t[1].trim().replace(/^['"]|['"]$/g, '')
        if (d) desc = d[1].trim().replace(/^['"]|['"]$/g, '').slice(0, 90)
      } catch { /* 读不到就用目录名 */ }
      out.push({ id: dirName, name: title, desc })
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id))
  skillCache = { at: now, value: out }
  return out
}

/** 角色（专家）名字。注意别和「权限」混淆：权限是能不能碰文件，专家是用哪个 agent。 */
const AGENT_LABELS = {
  'general-purpose': '通用',
  pulse: '研究',
  Explore: '探索',
  Plan: '规划',
  cli: 'CLI',
}

function defaultHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function newId(seq) {
  return `wb${Date.now().toString(36)}${seq.toString(36)}`.slice(0, 20)
}

/** 把一条 job 压成落盘/传输用的小对象（不带上正文以外的大字段）。 */
function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    source: job.source,
    prompt: job.prompt,
    agent: job.agent,
    model: job.model ?? '',
    gearLabel: job.gearLabel ?? '',
    createdAt: job.createdAt,
    startedAt: job.startedAt ?? null,
    endedAt: job.endedAt ?? null,
    elapsedMs: job.elapsedMs ?? null,
    text: job.text ?? '',
    error: job.error ?? '',
    port: job.port ?? null,
  }
}

export function createRuntime(config = {}) {
  const home = config.homeDir || defaultHome()
  const historyPath = config.historyPath || join(home, 'workbuddy', 'jobs.jsonl')
  // 模型 / 角色都从 WorkBuddy 的产品配置现读（见 loadCatalog），config 可强制覆盖。
  const forcedModels = Array.isArray(config.models) && config.models.length ? config.models : null
  const forcedAgents = Array.isArray(config.agents) && config.agents.length ? config.agents : null

  /** @type {Map<string, any>} 运行中的 job（只放还没结束的） */
  const live = new Map()
  /** @type {any[]} 全部 job，最新的在最后 */
  const jobs = []
  let seq = 0
  let historyLoaded = false

  function loadHistory() {
    if (historyLoaded) return
    historyLoaded = true
    try {
      if (!existsSync(historyPath)) return
      const lines = readFileSync(historyPath, 'utf8').split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const record = JSON.parse(trimmed)
          if (record && record.id) jobs.push({ ...record, restored: true })
        } catch { /* 半截行：跳过 */ }
      }
      while (jobs.length > MAX_JOBS) jobs.shift()
    } catch { /* 历史读不出来不影响新任务 */ }
  }

  function persist(job) {
    try {
      mkdirSync(dirname(historyPath), { recursive: true })
      appendFileSync(historyPath, JSON.stringify(publicJob(job)) + '\n', 'utf8')
    } catch { /* 落盘失败不影响内存账本 */ }
  }

  function trim() {
    while (jobs.length > MAX_JOBS) jobs.shift()
  }

  /**
   * 提交一次派活，立刻返回 job id；它自己在后台跑。
   * @param {object} input
   * @returns {{id: string, promise: Promise<any>}}
   */
  function submit(input = {}) {
    loadHistory()
    const job = {
      id: newId(++seq),
      status: 'running',
      source: input.source === 'panel' ? 'panel' : 'tool',
      prompt: input.prompt ? String(input.prompt) : '',
      agent: String(input.agent || forcedAgents?.[0]?.id || loadCatalog().agents[0] || 'general-purpose'),
      model: input.model ? String(input.model) : '',
      gearLabel: input.gearLabel ? String(input.gearLabel) : '',
      skill: input.skill ? String(input.skill) : '',
      fullAccess: input.fullAccess === true,
      system: input.system,
      maxTurns: input.maxTurns,
      timeoutSec: input.timeoutSec,
      createdAt: Date.now(),
      startedAt: Date.now(),
    }
    const controller = new AbortController()
    job.controller = controller
    live.set(job.id, job)
    jobs.push(job)
    trim()

    const promise = (async () => {
      try {
        // 派出去的任务书 = 技能/产物约定 + 用户原文（都不改用户写的东西，只加前缀）
        const finalPrompt = [
          job.skill ? `【使用技能】优先用「${job.skill}」这个技能完成任务。` : '',
          job.outputDir ? `【产物位置】本次新建的文件统一保存到 ${job.outputDir}（不存在就创建）；引用已有文件用绝对路径。` : '',
          job.prompt,
        ].filter(Boolean).join('\n\n')

        const result = await complete(
          finalPrompt,
          {
            agent: job.agent,
            model: job.model || undefined,
            system: job.system,
            maxTurns: job.maxTurns,
            timeoutSec: job.timeoutSec,
            fullAccess: job.fullAccess,
            signal: controller.signal,
          },
          config,
        )
        job.status = 'done'
        job.text = result.text
        job.port = result.endpoint?.port ?? null
        job.model = job.model || '(默认)'
      } catch (error) {
        const message = String(error?.message ?? error)
        job.status = controller.signal.aborted ? 'cancelled' : 'failed'
        job.error = message
      } finally {
        job.endedAt = Date.now()
        job.elapsedMs = job.endedAt - (job.startedAt ?? job.createdAt)
        live.delete(job.id)
        persist(job)
      }
      return publicJob(job)
    })()

    return { id: job.id, promise }
  }

  function cancel(id) {
    const job = live.get(id)
    if (!job) return false
    try { job.controller.abort() } catch { /* 已经结束 */ }
    return true
  }

  function find(id) {
    return jobs.find((job) => job.id === id)
  }

  function clearHistory() {
    for (const job of [...live.values()]) {
      try { job.controller.abort() } catch { /* ignore */ }
    }
    live.clear()
    jobs.length = 0
  }

  /** 面板轮询用的快照：新的在前，运行中的一定包含。 */
  function snapshot() {
    loadHistory()
    const ordered = [...jobs].sort((a, b) => b.createdAt - a.createdAt).slice(0, 120)
    const catalog = loadCatalog()
    const agentList = (forcedAgents ?? catalog.agents).map((a) =>
      typeof a === 'string' ? { id: a, name: AGENT_LABELS[a] || a, label: AGENT_LABELS[a] || a } : a,
    )
    return {
      jobs: ordered.map(publicJob),
      running: live.size,
      models: forcedModels ?? catalog.models,
      agents: agentList,
      skills: loadSkills(),
    }
  }

  return { submit, cancel, find, clearHistory, snapshot, jobs, live, historyPath }
}
