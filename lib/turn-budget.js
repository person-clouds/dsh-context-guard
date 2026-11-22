/** 单轮调用次数、步数（回合/会话）、压缩次数与累计输出门禁：按 session 计数，turn/start 时清零回合部分。 */

export const DEFAULT_MAX_CALLS_PER_TURN = 80
export const DEFAULT_HARD_MAX_CALLS_PER_TURN = 160
export const DEFAULT_MAX_TURN_OUTPUT_CHARS = 40000
export const DEFAULT_EXHAUSTED_OUTPUT_CHARS = 800
export const DEFAULT_MAX_STEPS_PER_TURN = 30
export const DEFAULT_HARD_MAX_STEPS_PER_TURN = 40
export const DEFAULT_MAX_STEPS_PER_SESSION = 60
export const DEFAULT_HARD_MAX_STEPS_PER_SESSION = 90
export const DEFAULT_MAX_COMPACTIONS = 1
export const DEFAULT_HARD_MAX_COMPACTIONS = 2

export class TurnBudget {
  constructor(options = {}) {
    this.maxCallsPerTurn = positiveInt(options.maxCallsPerTurn, DEFAULT_MAX_CALLS_PER_TURN)
    this.hardMaxCallsPerTurn = Math.max(
      this.maxCallsPerTurn,
      positiveInt(options.hardMaxCallsPerTurn, DEFAULT_HARD_MAX_CALLS_PER_TURN),
    )
    this.maxTurnOutputChars = positiveInt(options.maxTurnOutputChars, DEFAULT_MAX_TURN_OUTPUT_CHARS)
    this.exhaustedOutputChars = positiveInt(options.exhaustedOutputChars, DEFAULT_EXHAUSTED_OUTPUT_CHARS)
    this.maxStepsPerTurn = positiveInt(options.maxStepsPerTurn, DEFAULT_MAX_STEPS_PER_TURN)
    this.hardMaxStepsPerTurn = Math.max(
      this.maxStepsPerTurn,
      positiveInt(options.hardMaxStepsPerTurn, DEFAULT_HARD_MAX_STEPS_PER_TURN),
    )
    this.maxStepsPerSession = positiveInt(options.maxStepsPerSession, DEFAULT_MAX_STEPS_PER_SESSION)
    this.hardMaxStepsPerSession = Math.max(
      this.maxStepsPerSession,
      positiveInt(options.hardMaxStepsPerSession, DEFAULT_HARD_MAX_STEPS_PER_SESSION),
    )
    this.maxCompactions = positiveInt(options.maxCompactions, DEFAULT_MAX_COMPACTIONS)
    this.hardMaxCompactions = Math.max(
      this.maxCompactions,
      positiveInt(options.hardMaxCompactions, DEFAULT_HARD_MAX_COMPACTIONS),
    )
    this.logger = options.logger
    /** 按会话覆盖预算（核验态）：返回调用/输出/步数/压缩上限的子集。 */
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
    const maxStepsPerTurn = positiveInt(override?.maxStepsPerTurn, this.maxStepsPerTurn)
    const maxStepsPerSession = positiveInt(override?.maxStepsPerSession, this.maxStepsPerSession)
    const maxCompactions = positiveInt(override?.maxCompactions, this.maxCompactions)
    return {
      maxCallsPerTurn,
      hardMaxCallsPerTurn: Math.max(
        maxCallsPerTurn,
        positiveInt(override?.hardMaxCallsPerTurn, this.hardMaxCallsPerTurn),
      ),
      maxTurnOutputChars: positiveInt(override?.maxTurnOutputChars, this.maxTurnOutputChars),
      maxStepsPerTurn,
      hardMaxStepsPerTurn: Math.max(
        maxStepsPerTurn,
        positiveInt(override?.hardMaxStepsPerTurn, this.hardMaxStepsPerTurn),
      ),
      maxStepsPerSession,
      hardMaxStepsPerSession: Math.max(
        maxStepsPerSession,
        positiveInt(override?.hardMaxStepsPerSession, this.hardMaxStepsPerSession),
      ),
      maxCompactions,
      hardMaxCompactions: Math.max(
        maxCompactions,
        positiveInt(override?.hardMaxCompactions, this.hardMaxCompactions),
      ),
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
        steps: 0,
        approxSteps: 0,
        sessionSteps: 0,
        approxSessionSteps: 0,
        stepSeen: false,
        stepAsked: false,
        sessionStepAsked: false,
        compactions: 0,
        compactionAsked: false,
      }
      this.states.set(key, state)
    }
    return state
  }

  /** `session/event` 的 step/start：记录 step 并累加回合/会话步数。 */
  noteStep(sessionId, step) {
    const state = this.stateFor(sessionId)
    state.step = step === undefined || step === null || step === '' ? null : step
    state.stepSeen = true
    state.steps += 1
    state.sessionSteps += 1
    return state.step
  }

  /** `session/event` 的 turn/start：清零本轮调用数、步数与累计输出。 */
  startTurn(sessionId, turn = null) {
    const state = this.stateFor(sessionId)
    state.calls = 0
    state.emittedChars = 0
    state.turn = turn
    state.turnOpen = true
    state.askedThisTurn = false
    state.steps = 0
    state.approxSteps = 0
    state.stepAsked = false
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

  /**
   * 记录一次工具步并返回步数门禁结果。
   * 有 step/start 事件时按真实步数计；未收到事件时退化为「一次工具调用算一步」。
   * 顺序：回合硬线 → 会话硬线 → 回合提醒（每回合一次）→ 会话提醒（每会话一次）。
   */
  checkStep(sessionId) {
    const key = String(sessionId || 'unknown-session')
    const state = this.stateFor(key)
    if (!state.stepSeen) {
      state.approxSteps += 1
      state.approxSessionSteps += 1
    }
    const limits = this.limitsFor(key)
    const steps = state.steps + state.approxSteps
    const sessionSteps = state.sessionSteps + state.approxSessionSteps
    const base = {
      steps,
      sessionSteps,
      approx: !state.stepSeen,
      maxStepsPerTurn: limits.maxStepsPerTurn,
      hardMaxStepsPerTurn: limits.hardMaxStepsPerTurn,
      maxStepsPerSession: limits.maxStepsPerSession,
      hardMaxStepsPerSession: limits.hardMaxStepsPerSession,
    }
    if (steps >= limits.hardMaxStepsPerTurn) return { action: 'deny', scope: 'turn', ...base }
    if (sessionSteps >= limits.hardMaxStepsPerSession) return { action: 'deny', scope: 'session', ...base }
    if (!state.stepAsked && steps >= limits.maxStepsPerTurn) {
      state.stepAsked = true
      return { action: 'ask', scope: 'turn', ...base }
    }
    if (!state.sessionStepAsked && sessionSteps >= limits.maxStepsPerSession) {
      state.sessionStepAsked = true
      return { action: 'ask', scope: 'session', ...base }
    }
    return { action: 'allow', scope: null, ...base }
  }

  /** `session/event` 的 compaction/summary：累计压缩次数并给出该次压缩后的门禁结果。 */
  noteCompaction(sessionId) {
    const state = this.stateFor(sessionId)
    state.compactions += 1
    const limits = this.limitsFor(sessionId)
    const action = state.compactions >= limits.hardMaxCompactions
      ? 'deny'
      : state.compactions >= limits.maxCompactions ? 'ask' : 'allow'
    return {
      action,
      compactions: state.compactions,
      maxCompactions: limits.maxCompactions,
      hardMaxCompactions: limits.hardMaxCompactions,
    }
  }

  /** 压缩门禁：首次压缩后提醒收敛，达到硬线后拒绝后续工具调用（不自动填「继续」）。 */
  checkCompaction(sessionId) {
    const key = String(sessionId || 'unknown-session')
    const state = this.stateFor(key)
    const limits = this.limitsFor(key)
    const base = {
      compactions: state.compactions,
      maxCompactions: limits.maxCompactions,
      hardMaxCompactions: limits.hardMaxCompactions,
    }
    if (state.compactions <= 0) return { action: 'allow', ...base }
    if (state.compactions >= limits.hardMaxCompactions) return { action: 'deny', ...base }
    if (!state.compactionAsked) {
      state.compactionAsked = true
      return { action: 'ask', ...base }
    }
    return { action: 'allow', ...base }
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
