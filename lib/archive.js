/** 工具完整输出落盘。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { safeName } from './common.js'

function stamp(ms = Date.now()) {
  return new Date(ms).toISOString().replace(/[:.]/g, '-')
}

export async function writeToolLog(root, sessionId, callId, text, options = {}) {
  const sessionDir = join(root, safeName(sessionId))
  await mkdir(sessionDir, { recursive: true, mode: 0o700 })
  const path = join(sessionDir, `${stamp(options.now)}-${safeName(callId, 'call')}.log`)
  await writeFile(path, String(text), { encoding: 'utf8', mode: 0o600 })
  return { path, bytes: Buffer.byteLength(String(text), 'utf8') }
}
