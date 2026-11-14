import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { name, apply } from './index.js'

const dir = await mkdtemp(join(tmpdir(), 'dsh-context-guard-'))
const handlers = new Map()
const ctx = { on(type, fn) { handlers.set(type, fn) }, logger: { warn() {} } }
apply(ctx, { dir })
assert.equal(name, 'dsh-context-guard')
const session = {
  id: 'session-test',
  header: { cwd: '/home/zh/www/personalCloud' },
  snapshotEvents: () => [
    { type: 'session/title', data: { title: '测试压缩归档' } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '帮我检查 token 消耗' }] } },
    { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"ls"}' } },
  ],
}
handlers.get('session/event')(session, { type: 'compaction/start', data: { turn: 1 } })
await new Promise(resolve => setTimeout(resolve, 30))
let status = await readFile(join(dir, 'session-test', 'STATUS.md'), 'utf8')
assert.match(status, /压缩前快照/)
assert.match(status, /帮我检查 token 消耗/)

handlers.get('session/event')(session, { type: 'compaction/summary', data: {
  summary: [{ type: 'text', text: '## Primary Request\n- 检查 token' }],
  shadowedTokenCount: 12345, provider: 'p', model: 'm',
} })
await new Promise(resolve => setTimeout(resolve, 30))
status = await readFile(join(dir, 'session-test', 'STATUS.md'), 'utf8')
assert.match(status, /压缩完成/)
assert.match(status, /## Primary Request/)
assert.match(status, /约 12345 token/)
console.log('ok')
