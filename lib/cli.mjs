// 命令行测试入口：不重启 DSH 也能验证通道
//   node lib/cli.mjs probe
//   node lib/cli.mjs ask "把这句话翻译成英文：..." [--agent pulse] [--model glm-5.1] [--timeout 300]
import { complete, status } from './gateway.js'

const [cmd, ...rest] = process.argv.slice(2)

function flag(name, dflt) {
  const i = rest.indexOf(`--${name}`)
  return i >= 0 ? rest[i + 1] : dflt
}

if (cmd === 'probe') {
  const s = await status()
  console.log(JSON.stringify(s, null, 2))
} else if (cmd === 'ask') {
  const prompt = rest.find((a, i) => !a.startsWith('--') && !(rest[i - 1] ?? '').startsWith('--'))
  if (!prompt) {
    console.error('usage: node lib/cli.mjs ask "prompt" [--agent pulse] [--model ID] [--timeout 300]')
    process.exit(2)
  }
  const started = Date.now()
  try {
    const r = await complete(prompt, {
      agent: flag('agent'),
      model: flag('model'),
      timeoutSec: Number(flag('timeout', 300)),
    })
    console.log(`--- 用时 ${((Date.now() - started) / 1000).toFixed(1)}s, 端点 ${r.endpoint.port} (${r.endpoint.source}) ---`)
    console.log(r.text)
  } catch (error) {
    console.error('FAILED: ' + String(error?.message ?? error))
    process.exit(1)
  }
} else {
  console.error('usage: node lib/cli.mjs <probe|ask> ...')
  process.exit(2)
}
