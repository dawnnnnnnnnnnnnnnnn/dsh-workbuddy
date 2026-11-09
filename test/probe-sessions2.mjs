// 枚举 gateway 上和"会话/消息"有关的路径，找出哪个能不 404
import { resolveEndpoint } from '../lib/gateway.js'

const ep = await resolveEndpoint({})
const base = `http://127.0.0.1:${ep.port}`
const H = { Authorization: `Bearer ${ep.password}`, 'Content-Type': 'application/json' }
console.log(`endpoint ${ep.port}`)

// 拿一个真实会话 id
let sid = ''
try {
  const r = await fetch(base + '/api/v1/sessions', { headers: H, signal: AbortSignal.timeout(8000) })
  const j = await r.json()
  sid = j?.data?.sessions?.[0]?.id || ''
} catch {}
console.log('session id:', sid || '(none)')

const candidates = [
  ['GET', '/api/v1/sessions/' + sid],
  ['GET', '/api/v1/sessions/' + sid + '/messages'],
  ['GET', '/api/v1/agents'],
  ['GET', '/api/v1/tasks'],
  ['GET', '/api/v1/acp'],
  ['GET', '/api/v1/llm/completions'],
  ['POST', '/api/v1/sessions/' + sid + '/messages'],
  ['POST', '/api/v1/sessions/' + sid + '/chat'],
  ['POST', '/api/v1/sessions/' + sid + '/prompt'],
  ['POST', '/api/v1/sessions/messages'],
  ['POST', '/api/v1/agents/run'],
  ['POST', '/api/v1/agents/execute'],
  ['POST', '/api/v1/chat'],
  ['POST', '/api/v1/tasks'],
  ['POST', '/api/v1/acp'],
]

for (const [method, path] of candidates) {
  try {
    const res = await fetch(base + path, {
      method,
      headers: H,
      // POST 只发空对象，避免真的触发任务
      body: method === 'POST' ? '{}' : undefined,
      signal: AbortSignal.timeout(8000),
    })
    const text = (await res.text()).slice(0, 160).replace(/\s+/g, ' ')
    const flag = res.status === 404 ? '   ' : ' ★ '
    console.log(`${flag}${method.padEnd(5)} ${path.replace(sid, ':sid').padEnd(40)} → ${res.status}  ${text}`)
  } catch (e) {
    console.log(`   ${method.padEnd(5)} ${path.replace(sid, ':sid').padEnd(40)} → ERR ${String(e.message).slice(0, 60)}`)
  }
}
