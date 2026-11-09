// 验证「技能」真的会被执行：派一个指定 skill 的活，检查产物是否落地
//   node test/skill-live.mjs
import { tmpdir } from 'node:os'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { complete } from '../lib/gateway.js'

const OUT = join(tmpdir(), 'wb-skill-live').replace(/\\/g, '/')
mkdirSync(OUT, { recursive: true })

const target = `${OUT}/skill-test.pdf`
const prompt = [
  '【使用技能】优先用「workbuddy-pdf」这个技能完成任务。',
  '',
  `把“技能生效”四个字写成一个 PDF，保存到 ${target}`,
].join('\n')

console.log(`派活（产物目录 ${OUT}）…`)
const t0 = Date.now()
try {
  const r = await complete(prompt, { agent: 'general-purpose', timeoutSec: 300 })
  console.log(`用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  console.log('回复:', String(r.text || '').slice(0, 500))
} catch (e) {
  console.log('失败:', String(e.message).slice(0, 300))
}

console.log(existsSync(target) ? `产物存在: ${statSync(target).size} bytes` : '产物不存在')
