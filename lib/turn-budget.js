/** 单轮调用次数与累计输出门禁：按 session 计数，turn/start 时清零。 */

export const DEFAULT_MAX_CALLS_PER_TURN = 20
export const DEFAULT_HARD_MAX_CALLS_PER_TURN = 40
export const DEFAULT_MAX_TURN_OUTPUT_CHARS = 40000
export const DEFAULT_EXHAUSTED_OUTPUT_CHARS = 800

export class TurnBudget {
  constructor(options = {}) {
    this.maxCallsPerTurn = positiveInt(options.maxCallsPerTurn, DEFAULT_MAX_CALLS_PER_TURN)
    this.hardMaxCallsPerTurn = Math.max(
      this.maxCallsPerTurn,
      positiveInt(options.hardMaxCallsPerTurn, DEFAULT_HARD_MAX_CALLS_PER_TURN),
    )
    this.maxTurnOutputChars = positiveInt(options.maxTurnOutputChars, DEFAULT_MAX_TURN_OUTPUT_CHARS)
    this.exhaustedOutputChars = positiveInt(options.exhaustedOutputChars, DEFAULT_EXHAUSTED_OUTPUT_CHARS)
    this.logger = options.logger
    this.states = new Map()
    this.fallbackWarned = new Set()
  }

  stateFor(sessionId) {
    const key = String(sessionId || 'unknown-session')
    let state = this.states.get(key)
    if (!state) {
      state = {
        calls: 0,
        emittedChars: 0,
        turn: null,
        turnOpen: false,
        askedThisTurn: false,
      }
      this.states.set(key, state)
    }
    return state
  }

  /** `session/event` 的 turn/start：清零本轮调用数与累计输出。 */
  startTurn(sessionId, turn = null) {
    const state = this.stateFor(sessionId)
    state.calls = 0
    state.emittedChars = 0
    state.turn = turn
    state.turnOpen = true
    state.askedThisTurn = false
    return state
  }

  /**
   * 记录一次工具调用并返回门禁结果。
   * 第 maxCallsPerTurn+1 次返回 ask（每轮一次），第 hardMaxCallsPerTurn 次起 deny。
   */
  checkCall(sessionId) {
    const key = String(sessionId || 'unknown-session')
    const state = this.stateFor(key)
    if (!state.turnOpen && !this.fallbackWarned.has(key)) {
      this.fallbackWarned.add(key)
      this.logger?.warn?.('context-guard: 未收到 turn/start，单轮门禁退化为按 session 计数: %s', key)
    }
    state.calls++
    if (state.calls >= this.hardMaxCallsPerTurn) {
      return {
        action: 'deny',
        count: state.calls,
        maxCallsPerTurn: this.maxCallsPerTurn,
        hardMaxCallsPerTurn: this.hardMaxCallsPerTurn,
        fallback: !state.turnOpen,
      }
    }
    if (state.calls > this.maxCallsPerTurn) {
      if (state.askedThisTurn) {
        return {
          action: 'allow',
          count: state.calls,
          maxCallsPerTurn: this.maxCallsPerTurn,
          hardMaxCallsPerTurn: this.hardMaxCallsPerTurn,
          askSuppressed: true,
          fallback: !state.turnOpen,
        }
      }
      state.askedThisTurn = true
      return {
        action: 'ask',
        count: state.calls,
        maxCallsPerTurn: this.maxCallsPerTurn,
        hardMaxCallsPerTurn: this.hardMaxCallsPerTurn,
        fallback: !state.turnOpen,
      }
    }
    return {
      action: 'allow',
      count: state.calls,
      maxCallsPerTurn: this.maxCallsPerTurn,
      hardMaxCallsPerTurn: this.hardMaxCallsPerTurn,
      fallback: !state.turnOpen,
    }
  }

  /** 记录实际进入上下文的字符数；返回是否已超过单轮累计上限。 */
  consumeOutput(sessionId, chars) {
    const state = this.stateFor(sessionId)
    const before = state.emittedChars
    const added = Math.max(0, Number(chars) || 0)
    state.emittedChars = before + added
    return {
      before,
      added,
      after: state.emittedChars,
      limit: this.maxTurnOutputChars,
      exhausted: state.emittedChars > this.maxTurnOutputChars,
    }
  }

  isExhausted(sessionId) {
    return this.stateFor(sessionId).emittedChars > this.maxTurnOutputChars
  }

  reset(sessionId) {
    this.states.delete(String(sessionId || 'unknown-session'))
  }
}

function positiveInt(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback
}
