/**
 * dsh-workbuddy 宿主半 —— 把 WorkBuddy 桌面版当成一台可派活的工作台。
 *
 * 模型侧工具：
 *   workbuddy        把一段自包含任务交给 WorkBuddy，等它交回文本
 *   workbuddy_jobs   看这张交接账本（谁派的、什么模型、多久、交回了什么）
 *   workbuddy_probe  诊断通道（App 在不在、网关端口、探针状态）
 *
 * Web 侧：/dsh-workbuddy/* 路由 + client.js 里的右栏面板，共用同一个 runtime 账本，
 * 所以"模型派的活"和"面板手点的活"在同一张表上，彼此都看得见。
 */
import { createRuntime } from './runtime.js'
import { installRoutes } from './server.js'
import { status } from './gateway.js'

export const name = 'dsh-workbuddy'

const WORKBUDDY_DESCRIPTION = `Delegate a self-contained task to WorkBuddy (Tencent's CodeBuddy desktop AI workbench running on this machine) and get its answer back as text.

This is a real hand-off, not a text generator: the default agent (\`general-purpose\`) has its own Read / Write / Edit / Bash / PowerShell / Glob / Grep / WebFetch / WebSearch / Skill tools and its own shell, running on this same machine.

Use it when the job is better done by that workbench than here: a second opinion from a different model lineup (GLM / Kimi / MiniMax / DeepSeek), document and Office work through its skills, or a batch job you want out of this context.

How to call it:
- Write the prompt as a complete brief. WorkBuddy does NOT see this conversation, the workspace files, or your previous tool results. Every fact it needs must be in \`prompt\`: absolute paths, goal, constraints, output format.
- It works from its own directory, not yours. Give absolute paths (forward slashes are safest, e.g. \`D:/proj/out.md\`).
- One call = one task. Calls are independent: nothing carries over between them, so do not assume it remembers the previous call.
- Prefer \`agent: 'pulse'\` when you only want web research with no filesystem or shell access.
- Long tasks: give a bigger \`timeoutSec\`, or pass \`background: true\` to get a job id (collect with job_output).

Every call is also recorded in the WorkBuddy panel ledger (the right-sidebar tab), so the user can watch these hand-offs live alongside any they start by hand.

Return value is WorkBuddy's final text. Treat it as another agent's report: verify anything load-bearing (files it claims to have written, numbers, claims about the workspace) yourself before you rely on it.`

const JOBS_DESCRIPTION = `List recent WorkBuddy hand-offs from the shared ledger: which agent and model ran, whether it finished, how long it took, and the start of its reply. Use it to check on background hand-offs or to recall what WorkBuddy already did.`

const PROBE_DESCRIPTION = `Check whether the WorkBuddy desktop workbench channel is usable right now: is the app running, which loopback port its gateway is on, and whether the credential probe succeeds. Call this first when a workbuddy call fails, instead of retrying blindly.`

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['ok', 'text'],
    properties: {
      ok: { type: 'boolean', description: 'Whether the call succeeded.' },
      text: { type: 'string', description: "WorkBuddy's reply text, or an actionable error message." },
    },
  },
  render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
}

function ago(ms) {
  if (!ms || ms < 0) return '-'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m${String(s % 60).padStart(2, '0')}s`
}

export function apply(root, config = {}) {
  const runtime = createRuntime(config)

  root.inject(['tools'], (ctx) => {
    ctx.tools.register({
      name: 'workbuddy',
      description: WORKBUDDY_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Self-contained task brief for WorkBuddy. It cannot see this conversation, so include every path, constraint and required output format.',
          },
          agent: {
            type: 'string',
            description: "WorkBuddy agent name. Default 'general-purpose' (full tool access: files, shell, web). Use 'pulse' for research-only with no filesystem access.",
          },
          system: {
            type: 'string',
            description: 'Optional extra system prompt prepended on the WorkBuddy side.',
          },
          model: {
            type: 'string',
            description: 'Optional model id on the WorkBuddy side. Omit to let the panel/WorkBuddy default apply (fast-model).',
          },
          skill: {
            type: 'string',
            description: "Optional WorkBuddy skill id to force for this task (e.g. 'wechat-article-search', 'workbuddy-pdf'). Omit to let WorkBuddy pick the skill itself from the task text — that is usually the better choice.",
          },
          maxTurns: {
            type: 'number',
            description: 'Optional cap on agent turns for this task.',
          },
          fullAccess: {
            type: 'boolean',
            description: 'Ask WorkBuddy to bypass its permission prompts for this task. Default false.',
          },
          timeoutSec: {
            type: 'number',
            description: 'How long to wait for the answer, in seconds. Default 600, max 3600.',
          },
          background: {
            type: 'boolean',
            description: 'Return a job id immediately instead of waiting (collect with job_output). Default false = wait for the answer.',
          },
        },
        required: ['prompt'],
      },
      execute: async (args, exec) => {
        const prompt = String(args?.prompt ?? '').trim()
        if (!prompt) return { ok: false, text: 'ERROR: prompt 是空的。' }

        const options = {
          agent: args?.agent,
          system: args?.system,
          model: args?.model,
          skill: args?.skill,
          maxTurns: args?.maxTurns,
          fullAccess: args?.fullAccess,
          timeoutSec: args?.timeoutSec,
        }

        if (args?.background === true) {
          const jobs = typeof ctx.get === 'function' ? ctx.get('jobs') : undefined
          if (!jobs || typeof jobs.start !== 'function') {
            return {
              ok: false,
              text: 'BACKGROUND_UNAVAILABLE: 当前宿主没有后台任务服务（dsh-jobs）。去掉 background 改为同步调用。',
            }
          }
          let jobId = ''
          try {
            jobId = jobs.start({
              kind: 'workbuddy',
              label: `WorkBuddy: ${prompt.slice(0, 40)}`,
              owner: exec?.agent?.id,
              run: (handle) => {
                const started = Date.now()
                const tick = setInterval(() => {
                  handle.updateProgress(`WorkBuddy 干活中… ${Math.round((Date.now() - started) / 1000)}s`)
                }, 2000)
                const done = (async () => {
                  const submitted = runtime.submit({ source: 'tool', prompt, ...options })
                  const result = await submitted.promise
                  clearInterval(tick)
                  if (result.status === 'done') {
                    handle.append(result.text || '(WorkBuddy 返回空文本)')
                    return { status: 'completed', detail: 'done' }
                  }
                  handle.append(`ERROR: ${result.error ?? result.status}`)
                  return { status: 'failed', detail: String(result.error ?? result.status).slice(0, 200) }
                })()
                return { done, cancel: () => clearInterval(tick) }
              },
            })
          } catch (error) {
            return { ok: false, text: `BACKGROUND_FAILED: ${String(error?.message ?? error).slice(0, 300)}` }
          }
          return {
            ok: true,
            text: `已交给 WorkBuddy 后台执行（job ${jobId}）。跑完会通知你，用 job_output 取结果；面板的账本里也能看到它。`,
          }
        }

        const submitted = runtime.submit({ source: 'tool', prompt, ...options })
        const result = await submitted.promise
        if (result.status === 'done') {
          if (!result.text) return { ok: false, text: 'WorkBuddy 返回了空文本。换一种说法，或用 workbuddy_probe 看通道状态。' }
          return { ok: true, text: result.text }
        }
        return { ok: false, text: `ERROR: ${result.error || result.status}` }
      },
      output: TEXT_OUTPUT,
    })

    ctx.tools.register({
      name: 'workbuddy_jobs',
      description: JOBS_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'How many recent hand-offs to list. Default 10, max 50.' },
          status: { type: 'string', enum: ['any', 'running', 'done', 'failed', 'cancelled'], description: 'Filter by state. Default any.' },
        },
      },
      execute: async (args) => {
        const limit = Math.min(Math.max(Number(args?.limit) || 10, 1), 50)
        const want = String(args?.status ?? 'any')
        const all = runtime.snapshot().jobs
        const rows = (want === 'any' ? all : all.filter((j) => j.status === want)).slice(0, limit)
        if (!rows.length) return { ok: true, text: '账本是空的：还没有派过活。' }
        const lines = rows.map((j) => {
          const head = `${j.status.padEnd(9)} ${j.id}  ${j.agent} / ${j.model || '默认'}  ${ago(j.elapsedMs)}  [${j.source === 'panel' ? '面板' : '模型'}]`
          const brief = j.prompt.replace(/\s+/g, ' ').slice(0, 90)
          const tail = j.status === 'done'
            ? `\n    → ${j.text.replace(/\s+/g, ' ').slice(0, 140)}`
            : j.error ? `\n    ! ${j.error.slice(0, 160)}` : ''
          return `${head}\n    ${brief}${tail}`
        })
        return { ok: true, text: lines.join('\n') }
      },
      output: TEXT_OUTPUT,
    })

    ctx.tools.register({
      name: 'workbuddy_probe',
      description: PROBE_DESCRIPTION,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        try {
          const s = await status(config)
          if (!s.running) return { ok: false, text: `WorkBuddy 通道不可用：${s.reason}` }
          const lines = s.candidates.map((c) => {
            const ports = c.ports.length
              ? c.ports.map((p) => `${p.port}${p.ok ? ' ✓' : ` (HTTP ${p.status})`}`).join(', ')
              : '（无监听端口）'
            return `  pid ${c.pid}: ${ports}`
          })
          return {
            ok: s.gateway,
            text: [
              s.gateway ? 'WorkBuddy 通道可用。' : 'WorkBuddy 在跑，但没有可用的网关端口。',
              '预热进程：',
              ...lines,
            ].join('\n'),
          }
        } catch (error) {
          return { ok: false, text: `ERROR: ${String(error?.message ?? error)}` }
        }
      },
      output: TEXT_OUTPUT,
    })
  })

  // Web 面板的数据面：和上面三个工具共用同一个 runtime 账本。
  root.inject(['webServer'], (host) => installRoutes(host, runtime, config))
}
