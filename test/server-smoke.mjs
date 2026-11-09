// 宿主 HTTP 面的独立冒烟测试：不开 DSH，自己起个小 server 把同一批 handler 挂上去
//   node test/server-smoke.mjs
import http from 'node:http'
import { tmpdir } from 'node:os'
import { createRuntime } from '../lib/runtime.js'
import { installRoutes } from '../lib/server.js'

const OUT = tmpdir().replace(/\\/g, '/')

const routes = new Map()
const fakeHost = {
  webServer: {
    register(spec, label) {
      routes.set(spec.path, spec.handler)
      return () => routes.delete(spec.path)
    },
  },
}

const runtime = createRuntime({})
const disposers = installRoutes(fakeHost, runtime, {})
console.log(`routes: ${[...routes.keys()].join(', ')}`)

const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname
  const handler = routes.get(path)
  if (!handler) {
    res.writeHead(404).end('no route')
    return
  }
  Promise.resolve(handler(req, res)).catch((e) => {
    res.writeHead(500).end(String(e))
  })
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
console.log(`listening on ${base}`)

const getJson = async (path) => (await fetch(base + path)).json()
const postJson = async (path, body) =>
  (await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json()

const state1 = await getJson('/dsh-workbuddy/state')
console.log('\n[state] app =', JSON.stringify(state1.app))
console.log(`[state] models=${state1.models?.length} agents=${state1.agents?.length} jobs=${state1.jobs?.length}`)

const bad = await postJson('/dsh-workbuddy/submit', { prompt: '   ' })
console.log('[submit empty] ->', JSON.stringify(bad))

const submitted = await postJson('/dsh-workbuddy/submit', {
  prompt: `在 ${OUT}/panel-check.txt 用 Write 写入一行：PANEL_OK。写完只回复：完成`,
  agent: 'general-purpose',
})
console.log('[submit] ->', JSON.stringify(submitted))
if (!submitted.ok) {
  console.log('派活失败（可能是 WorkBuddy 没在跑），跳过后续')
} else {
  const jobId = submitted.jobId
  let job
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 1000))
    const s = await getJson('/dsh-workbuddy/state')
    job = (s.jobs || []).find((j) => j.id === jobId)
    process.stdout.write(job ? `.(${job.status})` : '.')
    if (job && job.status !== 'running') break
  }
  console.log(`\n[job ${jobId}] status=${job?.status} elapsed=${job?.elapsedMs}ms model=${job?.model} port=${job?.port}`)
  console.log('[job text]', (job?.text || job?.error || '').slice(0, 300))

  const cancel = await postJson('/dsh-workbuddy/cancel', { jobId })
  console.log('[cancel finished job] ->', JSON.stringify(cancel), '(404 是正常的：它已经跑完了)')
}

const state2 = await getJson('/dsh-workbuddy/state')
console.log(`\n[state] jobs=${state2.jobs?.length} running=${state2.running}`)
console.log(`[history] ${runtime.historyPath}`)

for (const d of disposers) d()
server.close()
