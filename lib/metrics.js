/** 指标记录：JSONL + 可读 STATUS.md 汇总，仅统计不展示 UI。 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { safeName } from './common.js'

export class MetricsRecorder {
  constructor(root, options = {}) {
    this.root = root
    this.statusEvery = Number(options.statusEvery) || 10
    this.logger = options.logger
    this.records = 0
    this.sessions = new Map()
    this.queue = Promise.resolve()
  }

  record(entry) {
    this.queue = this.queue.then(async () => {
      const session = safeName(entry.session, 'unknown-session')
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      await appendFile(join(this.root, `${session}.jsonl`), JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 })
      this.update(entry)
      if (this.records % this.statusEvery === 0) await this.writeStatus()
    }).catch(error => this.logger?.warn?.('context-guard: 指标写入失败: %s', error))
    return this.queue
  }

  update(entry) {
    this.records++
    const current = this.sessions.get(entry.session) || {
      session: entry.session,
      calls: 0,
      originalChars: 0,
      emittedChars: 0,
      savedChars: 0,
      dedup: 0,
      diffSummary: 0,
      errors: 0,
    }
    current.calls++
    current.originalChars += Number(entry.originalChars) || 0
    current.emittedChars += Number(entry.emittedChars) || 0
    current.savedChars += Number(entry.savedChars) || 0
    if (entry.dedup) current.dedup++
    if (entry.diffSummary) current.diffSummary++
    if (entry.isError) current.errors++
    this.sessions.set(entry.session, current)
  }

  async writeStatus() {
    const lines = [
      '# DSH context-guard 指标',
      '',
      `- 更新时间：${new Date().toISOString()}`,
      `- token 估算方法：\`chars/4\`（仅估算，不用于计费）`,
      '',
      '| 会话 | 调用 | 原始字符 | 进入上下文字符 | 节省字符 | 去重 | diff | 错误 | 估算节省 token |',
      '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ]
    for (const item of this.sessions.values()) {
      lines.push(`| \`${safeName(item.session)}\` | ${item.calls} | ${item.originalChars} | ${item.emittedChars} | ${item.savedChars} | ${item.dedup} | ${item.diffSummary} | ${item.errors} | ${Math.ceil(item.savedChars / 4)} |`)
    }
    lines.push('', '> 只统计 `tools/post-execute` 中命中的 bash 工具；去重不跳过执行。')
    await writeFile(join(this.root, 'STATUS.md'), lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 })
  }

  async flush() {
    await this.queue
    await this.writeStatus()
  }
}

export function metricOf({ session, callId, tool, cmdType, originalChars, emittedChars, dedup = false, diffSummary = false, isError = false, archived = null }) {
  const original = Number(originalChars) || 0
  const emitted = Number(emittedChars) || 0
  return {
    time: new Date().toISOString(),
    session,
    call: callId || null,
    tool: tool || null,
    cmdType: cmdType || 'default',
    originalChars: original,
    emittedChars: emitted,
    savedChars: Math.max(0, original - emitted),
    dedup: Boolean(dedup),
    diffSummary: Boolean(diffSummary),
    isError: Boolean(isError),
    archived: archived || null,
  }
}
