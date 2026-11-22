/** 单轮调用次数与累计输出门禁：按 session 计数，turn/start 时清零。 */

export const DEFAULT_MAX_CALLS_PER_TURN = 80
export const DEFAULT_HARD_MAX_CALLS_PER_TURN = 160
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
    /** 按会话覆盖预算（核验态）：返回 `{maxCallsPerTurn, hardMaxCallsPerTurn, maxTurnOutputChars}` 的子集。 */
    this.budgetFor = typeof options.budgetFor === 'function' ? options.budgetFor : null
    this.states = new Map()
    this.fallbackWarned = new Set()
  }

  /** 该会话本次生效的上限：覆盖值优先，未覆盖的项回落到实例默认。 */
  limitsFor(sessionId) {
    let override = null
    try {
      override = this.budgetFor ? this.budgetFor(sessionId) : null
    } catch {
      override = null
    }
    const maxCallsPerTurn = positiveInt(override?.maxCallsPerTurn, this.maxCallsPerTurn)
    return {
      maxCallsPerTurn,
      hardMaxCallsPerTurn: Math.max(
        maxCallsPerTurn,
        positiveInt(override?.hardMaxCallsPerTurn, this.hardMaxCallsPerTurn),
      ),
      maxTurnOutputChars: positiveInt(override?.maxTurnOutputChars, this.maxTurnOutputChars),
    }
  }

  stateFor(sessionId) {
    const key = String(sessionId || 'unknown-session')
    let state = this.states.get(key)
    if (!state) {
      state = {
        calls: 0,
        emittedChars: 0,
        turn: null,
        step: null,
        turnOpen: false,
      }
      this.states.set(key, state)
    }
    return state
  }

  /** `session/event` 的 step/start：记录当前 session step，仅用于展示。 */
  noteStep(sessionId, step) {
    const state = this.stateFor(sessionId)
    state.step = step === undefined || step === null || step === '' ? null : step
    return state.step
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
   * 每 maxCallsPerTurn 次返回 ask 提醒一次；第 hardMaxCallsPerTurn 次起 deny。
   */
  checkCall(sessionId) {
    const key = String(sessionId || 'unknown-session')
    const state = this.stateFor(key)
    if (!state.turnOpen && !this.fallbackWarned.has(key)) {
      this.fallbackWarned.add(key)
      this.logger?.warn?.('context-guard: 未收到 turn/start，单轮门禁退化为按 session 计数: %s', key)
    }
    state.calls++
    const limits = this.limitsFor(key)
    if (state.calls >= limits.hardMaxCallsPerTurn) {
      return {
        action: 'deny',
        count: state.calls,
        step: state.step,
        maxCallsPerTurn: limits.maxCallsPerTurn,
        hardMaxCallsPerTurn: limits.hardMaxCallsPerTurn,
        fallback: !state.turnOpen,
      }
    }
    if (state.calls % limits.maxCallsPerTurn === 0) {
      return {
        action: 'ask',
        count: state.calls,
        step: state.step,
        maxCallsPerTurn: limits.maxCallsPerTurn,
        hardMaxCallsPerTurn: limits.hardMaxCallsPerTurn,
        fallback: !state.turnOpen,
      }
    }
    return {
      action: 'allow',
      count: state.calls,
      step: state.step,
      maxCallsPerTurn: limits.maxCallsPerTurn,
      hardMaxCallsPerTurn: limits.hardMaxCallsPerTurn,
      fallback: !state.turnOpen,
    }
  }

  /** 记录实际进入上下文的字符数；返回是否已超过该会话的单轮累计上限。 */
  consumeOutput(sessionId, chars) {
    const state = this.stateFor(sessionId)
    const limit = this.limitsFor(sessionId).maxTurnOutputChars
    const before = state.emittedChars
    const added = Math.max(0, Number(chars) || 0)
    state.emittedChars = before + added
    return {
      before,
      added,
      after: state.emittedChars,
      limit,
      exhausted: state.emittedChars > limit,
    }
  }

  isExhausted(sessionId) {
    return this.stateFor(sessionId).emittedChars > this.limitsFor(sessionId).maxTurnOutputChars
  }

  reset(sessionId) {
    this.states.delete(String(sessionId || 'unknown-session'))
  }
}

function positiveInt(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback
}
