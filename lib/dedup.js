/** 会话内工具结果去重缓存与行级增量摘要。 */

export const DEFAULT_DEDUP_TTL_MS = 10 * 60 * 1000
export const DEFAULT_DEDUP_MAX_ENTRIES = 200
export const DEFAULT_DEDUPE_MIN_CHARS = 800

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}'
}

export function dedupKey(sessionId, toolName, args) {
  return `${sessionId}\u0000${toolName}\u0000${stableStringify(args)}`
}

export class DedupCache {
  constructor(options = {}) {
    this.ttlMs = Number(options.ttlMs) || DEFAULT_DEDUP_TTL_MS
    this.maxEntries = Number(options.maxEntries) || DEFAULT_DEDUP_MAX_ENTRIES
    this.entries = new Map()
  }

  get(key, now = Date.now()) {
    const entry = this.entries.get(key)
    if (!entry) return null
    if (now - entry.at > this.ttlMs) {
      this.entries.delete(key)
      return null
    }
    return entry
  }

  set(key, entry, now = Date.now()) {
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      let oldestKey = null
      let oldestAt = Infinity
      for (const [candidate, value] of this.entries) {
        if (value.at < oldestAt) {
          oldestAt = value.at
          oldestKey = candidate
        }
      }
      if (oldestKey !== null) this.entries.delete(oldestKey)
    }
    this.entries.set(key, { ...entry, at: now })
  }

  touch(key, now = Date.now()) {
    const entry = this.entries.get(key)
    if (entry) entry.at = now
  }

  clear() {
    this.entries.clear()
  }
}

function clippedLines(lines, maxLines) {
  if (lines.length <= maxLines) return lines
  const half = Math.max(1, Math.floor(maxLines / 2))
  return [
    ...lines.slice(0, half),
    `... 省略 ${lines.length - maxLines} 行 ...`,
    ...lines.slice(-half),
  ]
}

/** 行级 diff：公共前后缀 + 变化块；无变化返回 null。 */
export function diffLines(oldText, newText, options = {}) {
  const oldLines = String(oldText).split(/\r?\n/)
  const newLines = String(newText).split(/\r?\n/)
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix++

  if (prefix === oldLines.length && prefix === newLines.length) return null
  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix)
  const newMiddle = newLines.slice(prefix, newLines.length - suffix)
  const maxLines = Number(options.maxLines) || 40
  const removed = clippedLines(oldMiddle, maxLines).map(line => `- ${line}`)
  const added = clippedLines(newMiddle, maxLines).map(line => `+ ${line}`)
  return {
    changed: true,
    removedCount: oldMiddle.length,
    addedCount: newMiddle.length,
    summary: `@@ 第 ${prefix + 1} 行附近 @@\n${removed.join('\n')}${removed.length && added.length ? '\n' : ''}${added.join('\n')}`,
  }
}
