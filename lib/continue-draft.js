/** 硬上限后自动填入输入框的共享常量与预算。 */

export const CONTINUE_DRAFT_TEXT = '继续'
export const HARD_LIMIT_DRAFT_MARKER = 'context-guard:hard-limit-draft'
export const MAX_AUTO_CONTINUES_PER_SESSION = 3

/** 同一 session 最多 3 次，同一 turn 最多 1 次。 */
export class ContinueDraftBudget {
  constructor(maxPerSession = MAX_AUTO_CONTINUES_PER_SESSION) {
    this.maxPerSession = maxPerSession
    this.records = new Map()
  }

  /** @returns {boolean} 本次是否应写入「继续」。 */
  claim(sessionId, turn) {
    const key = String(sessionId)
    const record = this.records.get(key) ?? { count: 0, turns: new Set() }
    const turnKey = String(turn)
    if (record.count >= this.maxPerSession || record.turns.has(turnKey)) return false
    record.count += 1
    record.turns.add(turnKey)
    this.records.set(key, record)
    return true
  }

  count(sessionId) {
    return this.records.get(String(sessionId))?.count ?? 0
  }
}

/** 从会话事件窗口条目中提取硬上限拒绝的 turn；非目标事件返回 undefined。 */
export function hardLimitResultOf(entry) {
  if (entry?.type !== 'event' || entry.event?.type !== 'tool/result') return undefined
  const event = entry.event
  const data = event.data
  const reason = data?.error?.reason
  if (typeof reason === 'string' && reason.includes(HARD_LIMIT_DRAFT_MARKER)) {
    return { turn: data.turn, seq: event.seq }
  }
  const content = data?.message?.content
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part?.text === 'string' && part.text.includes(HARD_LIMIT_DRAFT_MARKER)) {
        return { turn: data.turn, seq: event.seq }
      }
    }
  }
  return undefined
}
