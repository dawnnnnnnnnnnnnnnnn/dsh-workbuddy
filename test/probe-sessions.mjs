// 绛夌綉鍏崇鍙ｅ氨缁悗锛屾帰涓€閬?sessions 鐩稿叧鎺ュ彛锛堢 2 灞傦細璁╀换鍔″嚭鐜板湪 WorkBuddy 閲岋級
import { resolveEndpoint } from '../lib/gateway.js'

const log = (...a) => console.log(...a)

// 1. 绛夌鐐?let ep = null
for (let i = 0; i < 20; i += 1) {
  try {
    ep = await resolveEndpoint({})
    break
  } catch (e) {
    if (i === 0 || i % 4 === 0) log(`waiting鈥?(${i}) ${String(e.message).slice(0, 60)}`)
    await new Promise((r) => setTimeout(r, 3000))
  }
}
if (!ep) {
  log('FAIL: 缃戝叧涓€鐩存病璧锋潵')
  process.exit(1)
}
log(`endpoint: port=${ep.port}`)

const base = `http://127.0.0.1:${ep.port}`
const H = { Authorization: `Bearer ${ep.password}`, 'Content-Type': 'application/json' }

async function hit(method, path, body) {
  try {
    const res = await fetch(base + path, {
      method,
      headers: H,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    })
    const text = await res.text()
    let brief = text.slice(0, 400)
    try {
      const j = JSON.parse(text)
      brief = JSON.stringify(j).slice(0, 400)
    } catch { /* keep raw */ }
    log(`${method.padEnd(5)} ${path.padEnd(34)} 鈫?${res.status}  ${brief}`)
    return { status: res.status, text }
  } catch (e) {
    log(`${method.padEnd(5)} ${path.padEnd(34)} 鈫?ERR ${String(e.message).slice(0, 80)}`)
    return { status: 0, text: '' }
  }
}

log('\n--- 鍙湅涓嶅啓 ---')
await hit('GET', '/api/v1/sessions')
await hit('GET', '/api/v1/settings')
await hit('GET', '/api/v1/product')

log('\n--- 灏濊瘯寤轰細璇濓紙鍙兘浼氬啓涓滆タ锛?---')
const created = await hit('POST', '/api/v1/sessions', { title: 'dsh probe', cwd: process.cwd() })
log('create raw:', created.text.slice(0, 400))
