// 探哪些 agentName 能干活：同一个问题问一遍，比较各自的工具/能力
import { complete } from './gateway.js'

const QUESTION =
  'One question, answer in 3 short lines. 1) List the exact tools you have available. ' +
  '2) Can you write a file to an absolute Windows path? 3) Can you run shell commands?'

const candidates = process.argv.slice(2)
if (candidates.length === 0) {
  console.error('usage: node lib/probe-agents.mjs <agentName> [agentName...]')
  process.exit(2)
}

for (const agentName of candidates) {
  const started = Date.now()
  try {
    const r = await complete(QUESTION, { agent: agentName, timeoutSec: 120 })
    const secs = ((Date.now() - started) / 1000).toFixed(1)
    console.log(`\n=============== agent=${agentName} (${secs}s, port ${r.endpoint.port}) ===============`)
    console.log(r.text.slice(0, 1200))
  } catch (error) {
    console.log(`\n=============== agent=${agentName} : FAILED ===============`)
    console.log(String(error?.message ?? error).slice(0, 400))
  }
}
