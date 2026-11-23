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
export const DEFAULT_CONTINUE_GRACE_SESSION_STEPS = 30

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
    this.continueGraceSessionSteps = positiveInt(
      options.continueGraceSessionSteps,
      DEFAULT_CONTINUE_GRACE_SESSION_STEPS,
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
        askTurnShown: false,
        compactions: 0,
        lastCompactionSeq: null,
        sessionGraceSteps: 0,
        allowSteps: false,
        allowRisk: false,
        allowExpiresAt: null,
      }
      this.states.set(key, state)
    }
    return state
  }

  /**
   * 一键放行：只写该 sessionId 自己的 state，不做任何全局/按 cwd 共享分支。
   * ttlMs > 0 记过期时间（填小时数）；缺省或 0 为本会话级（会话结束即失效）。
   * 返回生效后的投影，供 HTTP 路由直接回给前端。
   */
  allowFor(sessionId, options = {}) {
    const key = String(sessionId || '')
    if (!key) return { steps: false, risk: false, expiresAt: null, active: false, reason: 'session-required' }
    const state = this.stateFor(key)
    const ttlMs = Number(options.ttlMs)
    const expiresAt = Number.isFinite(ttlMs) && ttlMs > 0 ? Date.now() + ttlMs : null
    if (options.steps === true) state.allowSteps = true
    if (options.risk === true) state.allowRisk = true
    if (expiresAt !== null) state.allowExpiresAt = expiresAt
    return this.allowState(key)
  }

  /** 收回该会话的放行：步数与风险一起清空，步数硬线立即可见。 */
  revokeAllow(sessionId) {
    const key = String(sessionId || '')
    if (!key) return { steps: false, risk: false, expiresAt: null, active: false }
    const state = this.states.get(key)
    if (state) {
      state.allowSteps = false
      state.allowRisk = false
      state.allowExpiresAt = null
    }
    return this.allowState(key)
  }

  /**
   * 该会话当前有效的放行投影。sessionId 缺失/为空一律 fail-closed 返回 active:false，
   * 绝不回落到 `unknown-session` 这个共享桶；小时数到期后自动失效。
   */
  allowState(sessionId) {
    const key = String(sessionId || '')
    if (!key) return { steps: false, risk: false, expiresAt: null, active: false }
    const state = this.states.get(key)
    if (!state) return { steps: false, risk: false, expiresAt: null, active: false }
    const expired = state.allowExpiresAt !== null && Number(state.allowExpiresAt) <= Date.now()
    const steps = state.allowSteps === true && !expired
    const risk = state.allowRisk === true && !expired
    return {
      steps,
      risk,
      expiresAt: expired ? null : state.allowExpiresAt ?? null,
      active: steps || risk,
    }
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
    state.askTurnShown = false
    return state
  }

  /**
   * 记录一次工具调用并返回门禁结果。
   * 每 maxCallsPerTurn 次可提醒一次，但与步数提醒共用「每轮只放一条」的开关；
   * 第 hardMaxCallsPerTurn 次起 deny（拒绝不占提醒位）。
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
    // 一键放行（步数）：只保留「每满一轮调用提醒一次」，不再有 160 硬拒。
    if (this.allowState(key).steps) {
      const ask = state.calls % limits.maxCallsPerTurn === 0
      return {
        action: ask ? 'ask' : 'allow',
        count: state.calls,
        step: state.step,
        maxCallsPerTurn: limits.maxCallsPerTurn,
        hardMaxCallsPerTurn: limits.hardMaxCallsPerTurn,
        fallback: !state.turnOpen,
        allowed: true,
      }
    }
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
    if (state.calls % limits.maxCallsPerTurn === 0 && !state.askTurnShown) {
      state.askTurnShown = true
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
   * 顺序：回合硬线 → 会话硬线 → 回合提醒 → 会话提醒；提醒与 checkCall 共用
   * 「每轮只放一条」开关，且会话硬线可被用户回复「继续」抬高。
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
    const hardMaxStepsPerSession = limits.hardMaxStepsPerSession + state.sessionGraceSteps
    const base = {
      steps,
      sessionSteps,
      approx: !state.stepSeen,
      maxStepsPerTurn: limits.maxStepsPerTurn,
      hardMaxStepsPerTurn: limits.hardMaxStepsPerTurn,
      maxStepsPerSession: limits.maxStepsPerSession,
      hardMaxStepsPerSession,
      graceSteps: state.sessionGraceSteps,
    }
    // 一键放行（步数）：只计数、不提醒、不 deny，供面板显示真实进度。
    if (this.allowState(key).steps) return { action: 'allow', scope: null, allowed: true, ...base }
    if (steps >= limits.hardMaxStepsPerTurn) return { action: 'deny', scope: 'turn', ...base }
    if (sessionSteps >= hardMaxStepsPerSession) return { action: 'deny', scope: 'session', ...base }
    if (!state.askTurnShown && steps >= limits.maxStepsPerTurn) {
      state.stepAsked = true
      state.askTurnShown = true
      return { action: 'ask', scope: 'turn', ...base }
    }
    if (!state.askTurnShown && !state.sessionStepAsked && sessionSteps >= limits.maxStepsPerSession) {
      state.sessionStepAsked = true
      state.askTurnShown = true
      return { action: 'ask', scope: 'session', ...base }
    }
    return { action: 'allow', scope: null, ...base }
  }

  /**
   * 用户显式回复「继续」：只在本会话已到会话硬线时生效，每次抬高 +continueGraceSessionSteps 步。
   * 未到硬线返回 resumed:false，不消耗也不误报。
   */
  resumeByUser(sessionId) {
    const key = String(sessionId || 'unknown-session')
    const state = this.stateFor(key)
    const limits = this.limitsFor(key)
    const sessionSteps = state.sessionSteps + state.approxSessionSteps
    const hard = limits.hardMaxStepsPerSession + state.sessionGraceSteps
    if (sessionSteps < hard) {
      return {
        resumed: false,
        sessionSteps,
        hardMaxStepsPerSession: hard,
        remaining: hard - sessionSteps,
      }
    }
    state.sessionGraceSteps += this.continueGraceSessionSteps
    return {
      resumed: true,
      sessionSteps,
      graceSteps: this.continueGraceSessionSteps,
      hardMaxStepsPerSession: limits.hardMaxStepsPerSession + state.sessionGraceSteps,
    }
  }

  /** 汇总当前回合/会话的计数与上限，供 index 合并成一条提醒文案。 */
  summary(sessionId) {
    const key = String(sessionId || 'unknown-session')
    const state = this.stateFor(key)
    const limits = this.limitsFor(key)
    return {
      steps: state.steps + state.approxSteps,
      sessionSteps: state.sessionSteps + state.approxSessionSteps,
      calls: state.calls,
      compactions: state.compactions,
      approx: !state.stepSeen,
      maxStepsPerTurn: limits.maxStepsPerTurn,
      hardMaxStepsPerTurn: limits.hardMaxStepsPerTurn,
      maxStepsPerSession: limits.maxStepsPerSession,
      hardMaxStepsPerSession: limits.hardMaxStepsPerSession + state.sessionGraceSteps,
      maxCallsPerTurn: limits.maxCallsPerTurn,
      hardMaxCallsPerTurn: limits.hardMaxCallsPerTurn,
      maxCompactions: limits.maxCompactions,
      hardMaxCompactions: limits.hardMaxCompactions,
      graceSteps: state.sessionGraceSteps,
      lastCompactionSeq: state.lastCompactionSeq,
      allow: this.allowState(key),
    }
  }

  /**
   * `session/event` 的 compaction/summary：累计压缩次数、记录摘要事件序号。
   * 返回的 action 只用于 index 打 warn（达提醒点 / 达硬线各一次），不再参与工具拒绝。
   */
  noteCompaction(sessionId, seq = null) {
    const state = this.stateFor(sessionId)
    state.compactions += 1
    state.lastCompactionSeq = seq === undefined ? null : seq
    const limits = this.limitsFor(sessionId)
    const action = state.compactions >= limits.hardMaxCompactions
      ? 'warn-hard'
      : state.compactions >= limits.maxCompactions ? 'warn' : 'allow'
    return {
      action,
      compactions: state.compactions,
      maxCompactions: limits.maxCompactions,
      hardMaxCompactions: limits.hardMaxCompactions,
      lastCompactionSeq: state.lastCompactionSeq,
    }
  }

  /** 压缩门禁：永不 deny。达到硬线只附 `warning: true`，由 index 记 warning 并继续放行工具。 */
  checkCompaction(sessionId) {
    const key = String(sessionId || 'unknown-session')
    const state = this.stateFor(key)
    const limits = this.limitsFor(key)
    const base = {
      compactions: state.compactions,
      maxCompactions: limits.maxCompactions,
      hardMaxCompactions: limits.hardMaxCompactions,
      lastCompactionSeq: state.lastCompactionSeq,
    }
    if (state.compactions <= 0) return { action: 'allow', warning: false, ...base }
    return { action: 'allow', warning: state.compactions >= limits.hardMaxCompactions, ...base }
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

  /** 清空该会话的全部计数与放行项（会话销毁时由 index 调用）。 */
  reset(sessionId) {
    this.states.delete(String(sessionId || 'unknown-session'))
  }
}

function positiveInt(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback
}
