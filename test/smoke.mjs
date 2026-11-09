// 冒烟测试：不开 DSH，直接把插件模块按宿主的方式装一遍
//   node test/smoke.mjs          只验探测
//   node test/smoke.mjs --chat   额外真发一次任务
import { apply, name } from '../lib/index.js'

const tools = []
const fakeCtx = {
  tools: { register: (tool) => tools.push(tool) },
  get: () => undefined,
}
const fakeRoot = {
  inject(services, fn) {
    if (services.includes('tools')) fn(fakeCtx)
  },
}

apply(fakeRoot, {})

console.log(`plugin name: ${name}`)
console.log(`registered tools: ${tools.map((t) => t.name).join(', ')}`)
if (tools.length !== 3) {
  console.error('FAIL: expected 3 tools (workbuddy, workbuddy_jobs, workbuddy_probe)')
  process.exit(1)
}

const probe = tools.find((t) => t.name === 'workbuddy_probe')
const probeResult = await probe.execute({}, {})
console.log('\n--- workbuddy_probe ---')
console.log(probeResult.text)
console.log(`ok=${probeResult.ok}`)
// render 必须能把结果变成 text part
const rendered = probe.output.render({}, probeResult)
console.log(`render parts: ${rendered.length}, kind=${rendered[0]?.type}`)

if (process.argv.includes('--chat')) {
  const wb = tools.find((t) => t.name === 'workbuddy')
  const started = Date.now()
  const result = await wb.execute(
    { prompt: '只回复两个字：在的', timeoutSec: 120 },
    { agent: { id: 'smoke' } },
  )
  console.log('\n--- workbuddy (live call) ---')
  console.log(`ok=${result.ok} elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`)
  console.log(result.text.slice(0, 600))
}
