// ACP over HTTP 瀹屾暣娴佺▼锛歝onnect 鈫?initialize 鈫?session/new 鈫?session/prompt 鈫?鏀朵簨浠?import { randomUUID } from 'node:crypto'
import { resolveEndpoint } from '../lib/gateway.js'

const ep = await resolveEndpoint({})
const root = `http://127.0.0.1:${ep.port}/api/v1/acp`

let connId = randomUUID()
let sessionToken = ''

const headers = () => {
  const h = {
    Authorization: `Bearer ${ep.password}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'acp-connection-id': connId,
  }
  if (sessionToken) h['acp-session-token'] = sessionToken
  return h
}

/** 鎶?SSE 鍝嶅簲浣撹В鏋愭垚 JSON-RPC 娑堟伅鏁扮粍銆?*/
function parseSse(text) {
  const out = []
  const chunks = text.split(/\r?\n\r?\n/)
  for (const chunk of chunks) {
    const dataLines = chunk.split(/\r?\n/).filter((l) => l.startsWith('data:'))
    if (!dataLines.length) continue
    const payload = dataLines.map((l) => l.slice(5).trim()).join('\n')
    try { out.push(JSON.parse(payload)) } catch { /* 鍙兘鏄墖娈?*/ }
  }
  return out
}

async function post(method, params, timeoutMs = 30000) {
  const res = await fetch(root, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  return { status: res.status, messages: parseSse(text), raw: text }
}

// 1. connect
const c = await fetch(`${root}/connect`, { method: 'POST', headers: headers(), body: '{}' })
const cj = await c.json()
if (cj.connectionId) connId = cj.connectionId
if (cj.sessionToken) sessionToken = cj.sessionToken
console.log(`connect 鈫?${c.status}, connId=${connId}`)

// 2. initialize
const init = await post('initialize', {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: 'dsh-workbuddy', version: '0.1.0' },
})
console.log(`initialize 鈫?${init.status}, messages=${init.messages.length}`)

// 3. session/new
const created = await post('session/new', { cwd: process.cwd(), mcpServers: [] })
let sessionId = ''
for (const m of created.messages) {
  const sid = m?.params?.sessionId || m?.result?.sessionId || m?.result?.session_id
  if (sid) { sessionId = sid; break }
  const upd = m?.params?.update
  if (upd && upd.sessionUpdate) console.log('  update:', upd.sessionUpdate)
}
console.log(`session/new 鈫?${created.status}, sessionId=${sessionId || '(none)'}`)
if (!sessionId) {
  console.log('鍘熷鍝嶅簲锛?, created.raw.slice(0, 800))
  process.exit(0)
}

// 4. session/prompt 鈥斺€?鐪熺殑娲句竴涓换鍔?const promptText = '鍙洖澶嶄笁涓瓧锛氭敹鍒板暒銆備笉瑕佸啓鏂囦欢銆佷笉瑕佺敤宸ュ叿銆?
console.log(`\nsession/prompt 鈫?"${promptText}"`)
const prompted = await post('session/prompt', {
  sessionId,
  prompt: [{ type: 'text', text: promptText }],
}, 120000)

console.log(`prompt 鈫?${prompted.status}, messages=${prompted.messages.length}`)
for (const m of prompted.messages.slice(0, 20)) {
  const upd = m?.params?.update
  if (upd) {
    if (upd.sessionUpdate === 'agent_message_chunk') {
      process.stdout.write(upd.content?.text || '')
    } else if (upd.sessionUpdate === 'agent_message') {
      process.stdout.write(upd.message?.content?.[0]?.text || '')
    } else {
      console.log(`  [${upd.sessionUpdate}]`, JSON.stringify(upd).slice(0, 200))
    }
  } else if (m.result) {
    console.log('  result:', JSON.stringify(m.result).slice(0, 200))
  } else if (m.error) {
    console.log('  error:', JSON.stringify(m.error).slice(0, 200))
  }
}
console.log('\n\n=== 瀹屾暣鍘熸枃锛堝墠 1500 瀛楃锛?==')
console.log(prompted.raw.slice(0, 1500))
