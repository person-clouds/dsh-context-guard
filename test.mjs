import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { name, apply } from './index.js'
import { budgetFor, classifyCommand, renderBounded } from './lib/budget.js'
import { DedupCache } from './lib/dedup.js'
import { cleanupOutputs } from './lib/cleanup.js'

// 命令分类与预算
assert.equal(classifyCommand('cat /var/log/syslog'), 'unbounded')
assert.equal(classifyCommand('journalctl -u nginx -n 20'), 'logs')
assert.equal(classifyCommand('journalctl -u nginx'), 'unbounded')
assert.equal(classifyCommand('npm test'), 'build')
assert.equal(classifyCommand('git diff --stat'), 'diff')
assert.equal(classifyCommand('ps aux'), 'status')
assert.equal(classifyCommand("sed -n '1,10p' app.log"), 'source')
assert.equal(classifyCommand('# dsh-budget=8000\ncat app.log'), 'explicit')
assert.equal(budgetFor('ls', false, {}), 3000)
assert.equal(budgetFor('git diff', false, {}), 6000)
assert.equal(budgetFor('npm test', false, {}), 8000)
assert.equal(budgetFor('# dsh-budget=8000\ncat app.log', false, {}), 8000)
assert.equal(budgetFor('# dsh-budget=99999\ncat app.log', false, {}), 12000)

const bounded = renderBounded('x'.repeat(10000), { budget: 3000, header: 'H\n', footer: '\nF', headChars: 1200, tailChars: 800 })
assert.ok(bounded.length <= 3000, `bounded length ${bounded.length}`)
assert.match(bounded, /middle clipped/)
assert.ok(bounded.startsWith('H\n'))
assert.ok(bounded.endsWith('F'))

// 插件钩子
const dir = await mkdtemp(join(tmpdir(), 'dsh-context-guard-'))
const outputDir = join(dir, 'tool-output')
const handlers = new Map()
const ctx = {
  on(type, fn) {
    if (!handlers.has(type)) handlers.set(type, [])
    handlers.get(type).push(fn)
  },
  logger: { warn() {} },
}
apply(ctx, { dir, outputDir, metricsDir: join(dir, 'metrics'), thresholdChars: 3000, cleanupEnabled: false })
assert.equal(name, 'dsh-context-guard')

// 压缩归档
const session = {
  id: 'session-test',
  header: { cwd: '/home/zh/www/personalCloud' },
  snapshotEvents: () => [
    { type: 'session/title', data: { title: '测试上下文守卫' } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '帮我检查 token 消耗' }] } },
    { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"ls"}' } },
  ],
}
await handlers.get('session/event')[0](session, { type: 'compaction/start', data: { turn: 1 } })
await new Promise(resolve => setTimeout(resolve, 30))
let status = await readFile(join(dir, 'session-test', 'STATUS.md'), 'utf8')
assert.match(status, /压缩前快照/)
assert.match(status, /帮我检查 token 消耗/)

await handlers.get('session/event')[0](session, { type: 'compaction/summary', data: {
  summary: [{ type: 'text', text: '## Primary Request\n- 检查 token' }],
  shadowedTokenCount: 12345, provider: 'p', model: 'm',
} })
await new Promise(resolve => setTimeout(resolve, 30))
status = await readFile(join(dir, 'session-test', 'STATUS.md'), 'utf8')
assert.match(status, /压缩完成/)
assert.match(status, /## Primary Request/)
assert.match(status, /约 12345 token/)

// 大输出落盘 + 有界摘要
const fullText = Array.from({ length: 2000 }, (_, index) => `line-${index}-${'x'.repeat(20)}`).join('\n')
const exec = {
  name: 'bash',
  callId: 'call-test-1',
  arguments: { command: 'seq 1 2000' },
  agent: { id: 'session-test' },
}
const result = { isError: false, content: [{ type: 'text', text: fullText }] }
const decision = await handlers.get('tools/post-execute')[0](exec, result, async () => ({ kind: 'accept' }))
assert.equal(decision.kind, 'accept')
const emitted = decision.content[0].text
assert.ok(emitted.length <= 3000, `emitted length ${emitted.length}`)
assert.match(emitted, /完整输出:/)
assert.match(emitted, /middle clipped by dsh-context-guard/)

const files = await readdir(join(outputDir, 'session-test'))
assert.equal(files.length, 1)
const archived = await readFile(join(outputDir, 'session-test', files[0]), 'utf8')
assert.equal(archived, fullText)

// 去重缓存 TTL
const cache = new DedupCache({ ttlMs: 10, maxEntries: 2 })
cache.set('k', { hash: 'h' }, 100)
assert.equal(cache.get('k', 105)?.hash, 'h')
assert.equal(cache.get('k', 120), null)

// 相同命令再次执行：不跳过执行，只把重复结果换成指针
let nextCalls = 0
const secondExec = { ...exec, callId: 'call-test-2' }
const duplicate = await handlers.get('tools/post-execute')[0](secondExec, result, async () => {
  nextCalls++
  return { kind: 'accept' }
})
assert.equal(nextCalls, 1)
assert.match(duplicate.content[0].text, /\[context-guard:dedup\]/)
assert.match(duplicate.content[0].text, /call-test-1/)

// 输出变化：只回行级变化块
const changedResult = { isError: false, content: [{ type: 'text', text: fullText + '\nchanged-line' }] }
const changedExec = { ...exec, callId: 'call-test-3' }
const changed = await handlers.get('tools/post-execute')[0](changedExec, changedResult, async () => ({ kind: 'accept' }))
assert.match(changed.content[0].text, /\[context-guard:diff\]/)
assert.match(changed.content[0].text, /\+ changed-line/)

// 指标 JSONL
const metricFiles = await readdir(join(dir, 'metrics'))
assert.ok(metricFiles.includes('session-test.jsonl'))
const metricLines = (await readFile(join(dir, 'metrics', 'session-test.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
assert.ok(metricLines.length >= 3)
assert.ok(metricLines.some(item => item.dedup === true))
assert.ok(metricLines.some(item => item.diffSummary === true))
assert.ok(metricLines.every(item => item.savedChars >= 0))

// 清理：保留期内不删，过期且非当前会话最新文件删除
const cleanupDir = join(dir, 'cleanup-root')
await mkdir(join(cleanupDir, 'old-session'), { recursive: true })
await writeFile(join(cleanupDir, 'old-session', 'a.log'), 'aaa')
await writeFile(join(cleanupDir, 'old-session', 'b.log'), 'bbb')
const old = new Date(Date.now() - 10 * 86400000)
await utimes(join(cleanupDir, 'old-session', 'a.log'), old, old)
await utimes(join(cleanupDir, 'old-session', 'b.log'), old, old)
const cleaned = await cleanupOutputs(cleanupDir, { retentionDays: 7, currentSession: 'other' })
assert.equal(cleaned.deleted, 2)

// 低于预算保持原决策
const smallResult = { isError: false, content: [{ type: 'text', text: 'ok' }] }
const same = await handlers.get('tools/post-execute')[0](exec, smallResult, async () => ({ kind: 'accept' }))
assert.equal(same.kind, 'accept')
assert.equal(same.content, undefined)

console.log('ok')
