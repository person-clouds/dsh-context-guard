/** 核验态：按会话标题前缀切换调用/输出预算与只读规则，并对同快照重复派单去重。 */

/**
 * 默认只配一条核验态规则：标题以 `V:` 开头（`TODO：V:` 也算，全角/半角冒号都匹配）。
 * 硬拦只认标题，不看命令入口：配套 `dsh-workflow-shortcuts` 的 `/V` 与 `/VP` 都写 `V：`，
 * 手动改名同样生效；技能由 shortcuts 随包提供（`dsh-workflow-shortcuts/skills/change-verify`、
 * `dsh-workflow-shortcuts/skills/plan-verify`），阈值数字只在本文件维护。
 */
export const DEFAULT_SESSION_BUDGETS = [
  {
    match: '^(?:TODO[：:]\\s*)?V[：:]',
    label: '核验会话',
    maxCallsPerTurn: 25,
    hardMaxCallsPerTurn: 40,
    maxTurnOutputChars: 20000,
    // 核验会话步数更紧：默认 25 步提醒、40 步硬拒；会话/压缩沿用全局默认（60/90、1/2）。
    maxStepsPerTurn: 25,
    hardMaxStepsPerTurn: 40,
    // 除官方 write/edit 外，还要拦 dsh-ops 的写工具：它们名字不同，精确匹配才能挡住只读绕过。
    denyTools: [
      'write',
      'edit',
      'ops_write_file',
      'ops_edit_file',
      'ops_replace',
      'ops_remove',
      'ops_move',
      'ops_copy',
      'ops_batch',
    ],
    denyCommands: [
      '^\\s*(npm|pnpm|yarn)\\s+(i|install|ci)\\b',
      '^\\s*git\\s+(commit|push|add)\\b',
      '\\bsystemctl\\s+(--user\\s+)?(restart|stop|start|reload)\\b',
    ],
  },
]

export const DEFAULT_SESSION_TITLE_TTL_MS = 5000
export const DEFAULT_DISPATCH_WINDOW_MS = 2 * 60 * 60 * 1000
export const DEFAULT_DISPATCH_OVERRIDE = 'verify-again'

function safeRegExp(source) {
  if (source instanceof RegExp) return source
  try {
    return new RegExp(String(source))
  } catch {
    return null
  }
}

/** 编译配置里的预算规则；非法正则与空规则被丢弃，不影响其余规则。 */
export function compileBudgetRules(budgets) {
  const list = Array.isArray(budgets) ? budgets : []
  return list.map(item => {
    const re = safeRegExp(item?.match)
    const denyCommandRes = (Array.isArray(item?.denyCommands) ? item.denyCommands : [])
      .map(safeRegExp)
      .filter(Boolean)
    return {
      label: String(item?.label || item?.match || 'session-budget'),
      re,
      maxCallsPerTurn: Number(item?.maxCallsPerTurn) || undefined,
      hardMaxCallsPerTurn: Number(item?.hardMaxCallsPerTurn) || undefined,
      maxTurnOutputChars: Number(item?.maxTurnOutputChars) || undefined,
      maxStepsPerTurn: Number(item?.maxStepsPerTurn) || undefined,
      hardMaxStepsPerTurn: Number(item?.hardMaxStepsPerTurn) || undefined,
      maxStepsPerSession: Number(item?.maxStepsPerSession) || undefined,
      hardMaxStepsPerSession: Number(item?.hardMaxStepsPerSession) || undefined,
      maxCompactions: Number(item?.maxCompactions) || undefined,
      hardMaxCompactions: Number(item?.hardMaxCompactions) || undefined,
      denyTools: Array.isArray(item?.denyTools) ? item.denyTools.map(String) : [],
      denyCommandRes,
    }
  }).filter(rule => rule.re && (rule.maxCallsPerTurn || rule.hardMaxCallsPerTurn || rule.maxTurnOutputChars
    || rule.maxStepsPerTurn || rule.hardMaxStepsPerTurn || rule.maxStepsPerSession || rule.hardMaxStepsPerSession
    || rule.maxCompactions || rule.hardMaxCompactions
    || rule.denyTools.length > 0 || rule.denyCommandRes.length > 0))
}

/** 标题命中第一条规则即采用该规则（不叠加）；都不命中返回 null，走全局默认。 */
export function matchBudget(rules, title) {
  const text = String(title || '')
  if (!text) return null
  for (const rule of rules || []) {
    if (rule.re.test(text)) return rule
  }
  return null
}

/** 标题缓存：`sessionTitle.get()` 每次调用都查投影，5 秒内复用同一结果。 */
export class SessionTitleCache {
  constructor({ ttlMs = DEFAULT_SESSION_TITLE_TTL_MS, now = Date.now } = {}) {
    this.ttlMs = ttlMs
    this.now = now
    this.entries = new Map()
  }

  read(sessionId) {
    const key = String(sessionId || '')
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (this.now() - entry.at > this.ttlMs) {
      this.entries.delete(key)
      return undefined
    }
    return entry.title
  }

  write(sessionId, title) {
    this.entries.set(String(sessionId || ''), { at: this.now(), title: String(title || '') })
  }

  clear(sessionId) {
    if (sessionId === undefined) this.entries.clear()
    else this.entries.delete(String(sessionId || ''))
  }
}

/** 从派单 prompt 里取「快照：<sha>」；多个 SHA 排序去重后拼成指纹，取不到返回 ''。 */
export function snapshotFingerprint(text) {
  const source = String(text || '')
  const found = new Set()
  const re = /(?:快照|snapshot)\s*[:：]\s*([0-9a-f]{7,40})/gi
  let match = re.exec(source)
  while (match) {
    found.add(match[1].toLowerCase())
    match = re.exec(source)
  }
  return [...found].sort().join('|')
}

/** 同会话内同指纹在窗口期的第一次派单放行，第二次起判重复；prompt 带 override token 时放行。 */
export class DispatchRegistry {
  constructor({ windowMs = DEFAULT_DISPATCH_WINDOW_MS, now = Date.now } = {}) {
    this.windowMs = windowMs
    this.now = now
    this.entries = new Map()
  }

  /**
   * 返回 `{ duplicate, firstAt }`；不重复时登记本次派单。
   * key 为空（prompt 未声明快照）时直接放行且不登记，避免误伤普通子任务。
   */
  claim(sessionId, key, { overrideToken = DEFAULT_DISPATCH_OVERRIDE, prompt = '' } = {}) {
    if (!key) return { duplicate: false, firstAt: null }
    if (overrideToken && String(prompt).includes(overrideToken)) return { duplicate: false, firstAt: null }
    const session = String(sessionId || 'unknown-session')
    const now = this.now()
    const map = this.entries.get(session) || new Map()
    this.entries.set(session, map)
    for (const [existingKey, at] of map) {
      if (now - at > this.windowMs) map.delete(existingKey)
    }
    const firstAt = map.get(key)
    if (firstAt !== undefined) return { duplicate: true, firstAt }
    map.set(key, now)
    return { duplicate: false, firstAt: null }
  }

  reset(sessionId) {
    if (sessionId === undefined) this.entries.clear()
    else this.entries.delete(String(sessionId || 'unknown-session'))
  }
}
