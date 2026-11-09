// 璇曡蛋 ACP over HTTP锛歩nitialize 鈫?session/new 鈫?session/prompt
import { randomUUID } from 'node:crypto'
import { resolveEndpoint } from '../lib/gateway.js'

const ep = await resolveEndpoint({})
const base = `http://127.0.0.1:${ep.port}/api/v1/acp`
const conn = randomUUID()

// 鏈嶅姟绔?connect 涔嬪悗浼氬垎閰?connectionId + sessionToken锛屽悗缁姹傚繀椤诲甫杩欎袱涓?let connId = conn
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

let nextId = 1
async function rpc(method, params) {
  const body = { jsonrpc: '2.0', id: nextId++, method, params }
  const res = await fetch(base, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  })
  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* sse or raw */ }
  console.log(`\n${method} 鈫?${res.status}`)
  console.log((parsed ? JSON.stringify(parsed) : text).slice(0, 700))
  return { status: res.status, json: parsed, raw: text }
}

console.log('connection id:', conn)

// 0. 鍏堝缓杩炴帴锛堟湇鍔＄瑕佹眰锛?try {
  const res = await fetch(`http://127.0.0.1:${ep.port}/api/v1/acp/connect`, {
    method: 'POST',
    headers: headers(),
    body: '{}',
    signal: AbortSignal.timeout(15000),
  })
  const text = await res.text()
  console.log(`acp/connect 鈫?${res.status} ${text.slice(0, 400)}`)
  try {
    const j = JSON.parse(text)
    if (j.connectionId) connId = j.connectionId
    if (j.sessionToken) sessionToken = j.sessionToken
  } catch { /* ignore */ }
} catch (e) {
  console.log('acp/connect ERR', String(e.message).slice(0, 100))
}
console.log('using connectionId:', connId, 'token:', sessionToken ? 'yes' : 'no')

// 1. initialize
const init = await rpc('initialize', {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: 'dsh-workbuddy', version: '0.1.0' },
})
if (init.status !== 200) {
  console.log('\ninitialize 娌℃垚鍔燂紝鍚庨潰涓嶇敤璇曚簡')
  process.exit(0)
}

// 2. 鏂板缓浼氳瘽
const sess = await rpc('session/new', { cwd: process.cwd(), mcpServers: [] })
const sessionId =
  sess.json?.result?.sessionId ||
  sess.json?.result?.session_id ||
  sess.json?.result?.id ||
  ''
console.log('sessionId:', sessionId || '(鏈嬁鍒?')

if (!sessionId) {
  console.log('\n娌℃嬁鍒?sessionId锛岀湅鐪?result 缁撴瀯锛?, JSON.stringify(sess.json).slice(0, 500))
  process.exit(0)
}

// 3. 鍙戜竴鍙ヨ瘽
await rpc('session/prompt', {
  sessionId,
  prompt: [{ type: 'text', text: '鐢ㄤ竴鍙ヨ瘽璇存槑浣犵幇鍦ㄨ兘鐢ㄥ摢浜涘伐鍏凤紝涓嶈鍐欐枃浠? }],
})

// 4. 鏀朵簨浠舵祦锛堢煭璇伙級
console.log('\n--- SSE 浜嬩欢娴侊紙璇?8 绉掞級 ---')
try {
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(), 8000)
  const res = await fetch(base, {
    method: 'GET',
    headers: { ...headers(), Accept: 'text/event-stream' },
    signal: ctrl.signal,
  })
  console.log('GET status:', res.status, res.headers.get('content-type'))
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let acc = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    acc += dec.decode(value, { stream: true })
    if (acc.length > 4000) break
  }
  console.log(acc.slice(0, 2500))
} catch (e) {
  console.log('SSE 璇诲彇缁撴潫:', String(e.message).slice(0, 80))
}
