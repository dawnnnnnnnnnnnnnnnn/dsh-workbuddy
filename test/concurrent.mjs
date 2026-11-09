// 并发验证：同时派 3 个活，看它们是否真的并排跑、账本是否各自独立
//   node test/concurrent.mjs
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '../lib/runtime.js'

const runtime = createRuntime({ historyPath: join(tmpdir(), 'wb-concurrent-test.jsonl') })
const OUT = tmpdir().replace(/\\/g, '/')

const tasks = [
  `用 Write 在 ${OUT}/panel-a.txt 写一行 A_DONE，写完只回复：A`,
  `用 Write 在 ${OUT}/panel-b.txt 写一行 B_DONE，写完只回复：B`,
  '计算 12*34+56 的结果，只回复数字',
]

const started = Date.now()
const submitted = tasks.map((prompt, i) =>
  runtime.submit({ source: i === 2 ? 'tool' : 'panel', prompt, agent: 'general-purpose', model: i === 1 ? 'kimi-k2.5' : undefined }),
)
console.log(`submitted: ${submitted.map((s) => s.id).join(', ')}`)

// 边跑边看：谁先回来
const results = await Promise.all(submitted.map((s) => s.promise))
const total = Date.now() - started

console.log('')
for (const r of results) {
  console.log(`${r.id} [${r.source}] ${r.status} ${r.elapsedMs}ms model=${r.model} -> ${(r.text || r.error || '').replace(/\s+/g, ' ').slice(0, 60)}`)
}

const wall = results.map((r) => r.elapsedMs || 0)
const sum = wall.reduce((a, b) => a + b, 0)
console.log(`\n总墙钟 ${(total / 1000).toFixed(1)}s，各任务耗时之和 ${(sum / 1000).toFixed(1)}s`)
console.log(wall.length > 1 && total < sum * 0.85 ? '→ 确实是并发跑的' : '→ 看起来偏串行（也可能是任务太快，重叠不明显）')
console.log(`快照里的完成数：${runtime.snapshot().jobs.filter((j) => j.status === 'done').length}/${wall.length}`)
