/**
 * DSH context guard：工具输出预算/落盘、重复结果去重、只读诊断与压缩归档。
 *
 * - `tools/post-execute`：bash 输出超预算时完整落盘，上下文只留 head/tail/路径；
 * - `session/event`：压缩前写快照，压缩后把 DSH 结构化摘要写成 STATUS.md；
 * - 不额外调用模型，不改变压缩阈值，写入失败只 warning。
 */

import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { commandOf, dshHome, hashText, safeName, sessionIdOf, textOf as contentText } from './lib/common.js'
import { budgetFor, classifyCommand, renderBounded } from './lib/budget.js'
import { writeToolLog } from './lib/archive.js'
import { DEFAULT_DEDUPE_MIN_CHARS, DedupCache, dedupKey, diffLines } from './lib/dedup.js'
import { MetricsRecorder, metricOf } from './lib/metrics.js'
import { cleanupOutputs } from './lib/cleanup.js'
import { analyzeCommand, riskAskDecision } from './lib/risk.js'
import { PendingRiskRules, RISK_RULE_ENDPOINT, RiskRuleStore, effectiveAllowHosts, filterRiskByRules, normalizeRuleReason, ruleSpecsFor } from './lib/risk-allow.js'
import { lintCommand, lintDecision } from './lib/command-lint.js'
import {
  DEFAULT_CONTINUE_GRACE_SESSION_STEPS,
  DEFAULT_HARD_MAX_COMPACTIONS,
  DEFAULT_HARD_MAX_STEPS_PER_SESSION,
  DEFAULT_HARD_MAX_STEPS_PER_TURN,
  DEFAULT_MAX_COMPACTIONS,
  DEFAULT_MAX_STEPS_PER_SESSION,
  DEFAULT_MAX_STEPS_PER_TURN,
  TurnBudget,
} from './lib/turn-budget.js'
import {
  DEFAULT_DISPATCH_OVERRIDE,
  DEFAULT_DISPATCH_WINDOW_MS,
  DEFAULT_SESSION_BUDGETS,
  DispatchRegistry,
  SessionTitleCache,
  compileBudgetRules,
  matchBudget,
  snapshotFingerprint,
} from './lib/verify-mode.js'
import { HARD_LIMIT_DRAFT_MARKER } from './lib/continue-draft.js'

const execFileAsync = promisify(execFile)

export const name = 'dsh-context-guard'
export { HARD_LIMIT_DRAFT_MARKER } from './lib/continue-draft.js'

const DEFAULT_TOOL_NAMES = ['bash', 'persistent-bash', 'terminal-bash']
const DEFAULT_DISPATCH_TOOLS = ['subagent', 'subagent_fork', 'workflow']
/** 会话硬线后允许用户显式恢复的默认回复词；normalize 后做前缀匹配（如「继续吧」「继续执行」）。 */
const DEFAULT_CONTINUE_KEYWORDS = ['继续', 'continue']

function textOf(content) {
  return contentText(content)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n')
}

function userText(event) {
  return textOf(event?.data?.content)
}

/** 用户回复是否只是「继续」这类许可：去掉空白/标点后做前缀匹配，避免长句里带「继续」也误恢复。 */
function isContinueText(text, keywords) {
  const normalized = String(text || '').toLowerCase().replace(/[\s。.!！,，、；;：:]/g, '')
  if (!normalized) return false
  return keywords.some(keyword => {
    const word = String(keyword || '').toLowerCase().replace(/[\s。.!！,，、；;：:]/g, '')
    if (!word) return false
    return normalized === word || (normalized.startsWith(word) && normalized.length <= word.length + 4)
  })
}

function iso(ms) {
  return new Date(ms || Date.now()).toISOString()
}

function fence(text) {
  return '```\n' + String(text).replaceAll('```', '``\u200b`') + '\n```'
}

/** 解析命令中的 git commit 目标目录；支持 `git -C <dir> commit` 与前置 `cd <dir> && git commit`。 */
export function parseGitCommitCommand(command) {
  const text = String(command || '')
  if (!/(?:^|[;&|\s])git(?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+))?\s+commit(?:\s|$)/.test(text)) return null
  let cwd = null
  for (const segment of text.split(/&&|\|\||;|\n/)) {
    const part = segment.trim()
    const cd = part.match(/^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/)
    if (cd) cwd = cd[1] || cd[2] || cd[3]
    const direct = part.match(/(?:^|\s)git\s+-C\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+commit\b/)
    if (direct) return { cwd: direct[1] || direct[2] || direct[3] }
  }
  return { cwd }
}

async function repoIndex(workspaceRoot) {
  const yamlPath = join(workspaceRoot, 'repos.yaml')
  const repos = []
  let current = null
  let text = ''
  try {
    text = await readFile(yamlPath, 'utf8')
  } catch {
    return repos
  }
  for (const line of text.split(/\r?\n/)) {
    const id = line.match(/^\s*-\s+id:\s*["']?([^"'\s]+)["']?\s*$/)
    if (id) { current = { id: id[1], path: '' }; repos.push(current); continue }
    const path = line.match(/^\s*path:\s*["']?([^"'\s]+)["']?\s*$/)
    if (path && current) current.path = path[1]
  }
  return repos.filter(repo => repo.id && repo.path)
}

async function gitTopLevel(candidate, timeoutMs) {
  const cwd = candidate || process.cwd()
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { timeout: timeoutMs })
    return stdout.trim()
  } catch {
    return null
  }
}

function trimCheckOutput(value, max = 2400) {
  const text = String(value || '').trim()
  return text.length > max ? text.slice(0, max) + '\n[... 输出已截断 ...]' : text
}

async function defaultRunDocCheck(repoId, cfg) {
  const checkSh = join(cfg.docGuardWorkspaceRoot, 'scripts/check.sh')
  try {
    const { stdout, stderr } = await execFileAsync(checkSh, ['--repo', repoId], {
      cwd: cfg.docGuardWorkspaceRoot,
      timeout: cfg.docGuardTimeoutMs,
      maxBuffer: 1024 * 1024,
    })
    return { ok: true, output: `${stdout || ''}${stderr || ''}` }
  } catch (error) {
    const output = `${error?.stdout || ''}${error?.stderr || ''}` || error?.message || String(error)
    return { ok: false, output }
  }
}

/** 提交前文档门禁：目标仓已登记时按工作区中央策略运行 check.sh --repo。 */
export async function docGuardDecision(command, cfg, logger, deps = {}) {
  if (!cfg?.docGuardEnabled) return null
  const parsed = parseGitCommitCommand(command)
  if (!parsed) return null
  const workspaceRoot = cfg.docGuardWorkspaceRoot
  const repoRoot = await gitTopLevel(deps.cwd || parsed.cwd, cfg.docGuardTimeoutMs)
  if (!repoRoot) return null
  const repos = await repoIndex(workspaceRoot)
  const normalizedRoot = resolve(repoRoot)
  const matched = repos
    .map(repo => ({ ...repo, absolute: resolve(repo.path) }))
    .filter(repo => normalizedRoot === repo.absolute || normalizedRoot.startsWith(repo.absolute + sep))
    .sort((a, b) => b.absolute.length - a.absolute.length)[0]
  if (!matched) {
    logger?.warn?.('context-guard: 文档门禁未找到仓库登记: %s', repoRoot)
    return null
  }
  const runCheck = deps.runCheck || defaultRunDocCheck
  const result = await runCheck(matched.id, cfg)
  if (result.ok) return null
  const output = trimCheckOutput(result.output)
  const reason = `文档检查未通过，已阻止 git commit（仓库 ${matched.id}）：\n${output}`
  return {
    kind: 'deny',
    reason,
    displayReason: {
      en: `Documentation check failed for ${matched.id}; commit blocked.\n${output}`,
      zh: reason,
    },
  }
}

/** 从 session 的已提交事件里取标题、最近用户消息和最近工具调用。 */
export function snapshotOf(session, limit = 8) {
  const events = session.snapshotEvents()
  const titleEvent = [...events].reverse().find(event => event.type === 'session/title')
  const users = events
    .filter(event => event.type === 'user/message')
    .map(event => userText(event))
    .filter(Boolean)
    .slice(-limit)
  const tools = events
    .filter(event => event.type === 'tool/call')
    .map(event => `${event.data?.name || 'tool'} ${String(event.data?.arguments || '').slice(0, 160)}`)
    .slice(-20)
  return {
    title: titleEvent?.data?.title || '(未命名会话)',
    cwd: session.header?.cwd || '',
    users,
    tools,
  }
}

function renderStatus({ session, snapshot, phase, summary, meta }) {
  const lines = [
    '# DSH 上下文守卫 STATUS',
    '',
    `- 会话：\`${session.id}\``,
    `- 标题：${snapshot.title}`,
    `- 工作目录：\`${snapshot.cwd || '(未知)'}\``,
    `- 更新时间：${iso(Date.now())}`,
    `- 阶段：${phase}`,
  ]
  if (meta) {
    lines.push(`- 触发：${meta.trigger || 'compaction'}`)
    if (meta.shadowedTokenCount !== undefined) lines.push(`- 本次被压缩上下文：约 ${meta.shadowedTokenCount} token`)
    if (meta.model) lines.push(`- 摘要模型：${meta.provider || ''}/${meta.model}`)
  }
  lines.push('', '## 最近用户意图', '')
  if (snapshot.users.length === 0) lines.push('- (无)')
  else for (const text of snapshot.users) lines.push(`- ${text.replaceAll('\n', ' ').slice(0, 500)}`)
  lines.push('', '## 最近工具调用', '')
  if (snapshot.tools.length === 0) lines.push('- (无)')
  else for (const text of snapshot.tools) lines.push(`- \`${text.replaceAll('\n', ' ')}\``)
  if (summary) {
    lines.push('', '## DSH 压缩摘要', '', fence(summary))
  } else {
    lines.push('', '## DSH 压缩摘要', '', '压缩正在进行；摘要生成后本文件会更新。')
  }
  return lines.join('\n') + '\n'
}

async function writeArchive(session, phase, summary, meta, dir) {
  const snapshot = snapshotOf(session)
  const root = dir || join(dshHome(), 'context-guard', 'archive')
  const sessionDir = join(root, safeName(session.id))
  await mkdir(sessionDir, { recursive: true })
  const status = join(sessionDir, 'STATUS.md')
  await writeFile(status, renderStatus({ session, snapshot, phase, summary, meta }), 'utf8')
  if (summary) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await writeFile(join(sessionDir, `${stamp}-compaction.md`), renderStatus({ session, snapshot, phase, summary, meta }), 'utf8')
  }
  return status
}

function guardConfig(config) {
  const toolNames = Array.isArray(config.toolNames) && config.toolNames.length > 0 ? config.toolNames : DEFAULT_TOOL_NAMES
  return {
    enabled: config.enabled !== false,
    toolNames,
    riskCheckEnabled: config.riskCheckEnabled !== false,
    riskToolNames: Array.isArray(config.riskToolNames) && config.riskToolNames.length > 0
      ? config.riskToolNames
      : [...new Set([...toolNames, 'web_fetch'])],
    riskAllowHosts: Array.isArray(config.riskAllowHosts) ? config.riskAllowHosts : undefined,
    riskAutoAllowEnabled: config.riskAutoAllowEnabled !== false,
    riskRuleFile: typeof config.riskRuleFile === 'string' && config.riskRuleFile
      ? config.riskRuleFile
      : join(dshHome(), 'context-guard', 'risk-allow.json'),
    commandLintEnabled: config.commandLintEnabled !== false,
    commandLintMode: config.commandLintMode === 'ask' ? 'ask' : 'deny',
    commandGuidanceEnabled: config.commandGuidanceEnabled !== false,
    maxCallsPerTurn: Number(config.maxCallsPerTurn) || 80,
    hardMaxCallsPerTurn: Number(config.hardMaxCallsPerTurn) || 160,
    maxTurnOutputChars: Number(config.maxTurnOutputChars) || 40000,
    exhaustedOutputChars: Number(config.exhaustedOutputChars) || 800,
    stepBudget: {
      enabled: config.stepBudget?.enabled !== false,
      maxStepsPerTurn: Number(config.stepBudget?.maxStepsPerTurn) || DEFAULT_MAX_STEPS_PER_TURN,
      hardMaxStepsPerTurn: Number(config.stepBudget?.hardMaxStepsPerTurn) || DEFAULT_HARD_MAX_STEPS_PER_TURN,
      maxStepsPerSession: Number(config.stepBudget?.maxStepsPerSession) || DEFAULT_MAX_STEPS_PER_SESSION,
      hardMaxStepsPerSession: Number(config.stepBudget?.hardMaxStepsPerSession) || DEFAULT_HARD_MAX_STEPS_PER_SESSION,
      maxCompactions: Number(config.stepBudget?.maxCompactions) || DEFAULT_MAX_COMPACTIONS,
      hardMaxCompactions: Number(config.stepBudget?.hardMaxCompactions) || DEFAULT_HARD_MAX_COMPACTIONS,
      continueResume: config.stepBudget?.continueResume !== false,
      continueGraceSessionSteps: Number(config.stepBudget?.continueGraceSessionSteps)
        || DEFAULT_CONTINUE_GRACE_SESSION_STEPS,
      continueKeywords: Array.isArray(config.stepBudget?.continueKeywords)
        && config.stepBudget.continueKeywords.length > 0
        ? config.stepBudget.continueKeywords.map(String)
        : DEFAULT_CONTINUE_KEYWORDS,
    },
    sessionBudgets: Array.isArray(config.sessionBudgets) ? config.sessionBudgets : DEFAULT_SESSION_BUDGETS,
    sessionTitleTtlMs: Number(config.sessionTitleTtlMs) || 5000,
    dispatchGuard: {
      enabled: config.dispatchGuard?.enabled !== false,
      windowMs: Number(config.dispatchGuard?.windowMs) || DEFAULT_DISPATCH_WINDOW_MS,
      overrideToken: typeof config.dispatchGuard?.overrideToken === 'string' && config.dispatchGuard.overrideToken
        ? config.dispatchGuard.overrideToken
        : DEFAULT_DISPATCH_OVERRIDE,
    },
    dispatchTools: Array.isArray(config.dispatchTools) && config.dispatchTools.length > 0
      ? config.dispatchTools.map(String)
      : DEFAULT_DISPATCH_TOOLS,
    outputDir: typeof config.outputDir === 'string' && config.outputDir ? config.outputDir : join(dshHome(), 'tool-output'),
    thresholdChars: config.thresholdChars,
    headChars: config.headChars,
    tailChars: config.tailChars,
    hardMaxChars: config.hardMaxChars,
    errorBudgetChars: config.errorBudgetChars,
    categoryBudgets: config.categoryBudgets,
    dedupEnabled: config.dedupEnabled !== false,
    dedupTtlMs: config.dedupTtlMs,
    dedupMaxEntries: config.dedupMaxEntries,
    dedupeMinChars: config.dedupeMinChars,
    metricsEnabled: config.metricsEnabled !== false,
    metricsDir: typeof config.metricsDir === 'string' && config.metricsDir ? config.metricsDir : join(dshHome(), 'context-guard', 'metrics'),
    cleanupEnabled: config.cleanupEnabled !== false,
    cleanup: Object.fromEntries(Object.entries({
      retentionDays: config.retentionDays,
      maxSessionBytes: config.maxSessionBytes,
      maxTotalBytes: config.maxTotalBytes,
      maxFilesPerSession: config.maxFilesPerSession,
      keepRecentInActiveSession: config.keepRecentInActiveSession,
    }).filter(([, value]) => value !== undefined)),
    cleanupIntervalMs: Number(config.cleanupIntervalMs) || 5 * 60 * 1000,
    docGuardEnabled: config.docGuardEnabled !== false,
    docGuardWorkspaceRoot: typeof config.docGuardWorkspaceRoot === 'string' && config.docGuardWorkspaceRoot
      ? config.docGuardWorkspaceRoot
      : '/home/zh/www',
    docGuardTimeoutMs: Number(config.docGuardTimeoutMs) || 30000,
  }
}

let lastCleanupAt = 0

function maybeCleanup(cfg, currentSession, logger) {
  if (!cfg.cleanupEnabled) return
  const now = Date.now()
  if (now - lastCleanupAt < cfg.cleanupIntervalMs) return
  lastCleanupAt = now
  void cleanupOutputs(cfg.outputDir, { ...cfg.cleanup, currentSession, now })
    .catch(error => logger?.warn?.('context-guard: 清理工具输出失败: %s', error))
}

function mergeAskDecisions(decisions) {
  if (decisions.length === 1) return decisions[0]
  return {
    kind: 'ask',
    reason: decisions.map(item => item.reason).join('; '),
    displayReason: {
      en: decisions.map(item => item.displayReason?.en || item.reason).join('\n\n'),
      zh: decisions.map(item => item.displayReason?.zh || item.reason).join('\n\n'),
    },
  }
}

function stepLabel(step, locale) {
  if (step === null || step === undefined || step === '') return locale === 'en' ? 'unknown' : '未知'
  return String(step)
}

/** 核验态下会话标题：`sessionTitle.get(session)` 的返回值可能是字符串或带 title 的快照。 */
function sessionTitleOf(ctx, exec, cache) {
  const sessionId = sessionIdOf(exec)
  const cached = cache.read(sessionId)
  if (cached !== undefined) return cached
  let title = ''
  try {
    const titles = ctx.get('sessionTitle')
    const session = exec?.agent?.session
    if (titles && typeof titles.get === 'function' && session) {
      const value = titles.get(session)
      title = typeof value === 'string' ? value : String(value?.title || '')
    }
  } catch {
    title = ''
  }
  cache.write(sessionId, title)
  return title
}

/** 派单类工具的 prompt：把 arguments 里常见的文本字段拼起来，供快照指纹与 override 判定。 */
function promptOf(exec) {
  const args = exec?.arguments || {}
  const parts = []
  for (const field of ['prompt', 'task', 'description', 'instructions', 'message', 'goal']) {
    const value = args[field]
    if (typeof value === 'string') parts.push(value)
  }
  if (Array.isArray(args.messages)) {
    for (const message of args.messages) {
      if (typeof message === 'string') parts.push(message)
      else if (typeof message?.content === 'string') parts.push(message.content)
    }
  }
  return parts.join('\n')
}

function verifyDenyToolDecision(rule, toolName) {
  const label = rule.label || '核验会话'
  return {
    kind: 'deny',
    reason: `context-guard verify-mode: ${label}只读，禁止调用 ${toolName}；补丁请在 \`/G\` 实现会话里改，核验只报告。`,
    displayReason: {
      en: `context-guard verify-mode: session "${label}" is read-only, so ${toolName} is blocked. Edit in the implementation session, not the verification session.`,
      zh: `核验会话只读：已在 ${label} 拦截 ${toolName}。补丁回实现会话（\`/G\`）修改，核验会话只报告结论。`,
    },
  }
}

function verifyDenyCommandDecision(rule, command) {
  const label = rule.label || '核验会话'
  const preview = String(command).replaceAll('\n', ' ').slice(0, 160)
  return {
    kind: 'deny',
    reason: `context-guard verify-mode: ${label}禁止破坏性命令（装依赖/改仓库/重启服务），已拦截: ${preview}`,
    displayReason: {
      en: `context-guard verify-mode: destructive commands (installs, repo writes, service restarts) are blocked in a verification session. Blocked: ${preview}`,
      zh: `核验会话只读：装依赖、改仓库、重启服务在核验态一律拦截。被拦命令：${preview}`,
    },
  }
}

function dispatchDuplicateDecision(key, firstAt) {
  return {
    kind: 'deny',
    reason: `context-guard dispatch-guard: 快照 ${key} 本轮已派过核验（首次 ${iso(firstAt)}），重复派单已拦截；确需复验请在 prompt 里写 verify-again。`,
    displayReason: {
      en: `context-guard dispatch-guard: snapshot ${key} was already dispatched for review at ${iso(firstAt)}. Duplicate dispatch blocked; add \`verify-again\` to the prompt if a re-check is really needed.`,
      zh: `同一快照 ${key} 已在 ${iso(firstAt)} 派过核验，重复派单已拦截。复验确实需要时，在派单 prompt 里写明 verify-again。`,
    },
  }
}

/** 每轮最多一条的合并提醒：把会话步数 / 本轮步数 / 命令调用 / 压缩次数放在同一张卡片里。 */
function budgetAskDecision(summary, scope) {
  const approx = summary.approx ? '（近似计步）' : ''
  const scopeZh = scope === 'session' ? '本会话累计步数已达提醒点' : scope === 'turn' ? '本轮步数已达提醒点' : '本轮命令调用已达提醒点'
  const continueHint = summary.graceSteps > 0 ? `；本轮已由「继续」恢复 ${summary.graceSteps} 步` : ''
  return {
    kind: 'ask',
    reason: `context-guard step-budget: ${scopeZh}${approx}。本轮 ${summary.steps} 步 / 本会话 ${summary.sessionSteps} 步，本轮 bash ${summary.calls} 次，本会话已压缩 ${summary.compactions} 次${continueHint}；是否继续？建议先收敛「已完成 / 未完成 / 下一步」。`,
    displayReason: {
      en: `context-guard step-budget: ${scope === 'session' ? 'session step' : scope === 'turn' ? 'turn step' : 'bash call'} reminder${approx}. Turn ${summary.steps} steps / session ${summary.sessionSteps} steps, ${summary.calls} bash calls this turn, ${summary.compactions} compaction(s) this session${summary.graceSteps > 0 ? `, +${summary.graceSteps} steps resumed by "continue"` : ''}. Continue? Write "done / todo / next" first. Limits: turn ${summary.maxStepsPerTurn}/${summary.hardMaxStepsPerTurn}, session ${summary.maxStepsPerSession}/${summary.hardMaxStepsPerSession}, calls ${summary.maxCallsPerTurn}/${summary.hardMaxCallsPerTurn}, compactions soft ${summary.maxCompactions} (never denied).`,
      zh: `${scopeZh}${approx}。本轮 ${summary.steps} 步 / 本会话 ${summary.sessionSteps} 步，本轮 bash 调用 ${summary.calls} 次，本会话已压缩 ${summary.compactions} 次${continueHint}。上限：回合 ${summary.maxStepsPerTurn}/${summary.hardMaxStepsPerTurn}、会话 ${summary.maxStepsPerSession}/${summary.hardMaxStepsPerSession}、调用 ${summary.maxCallsPerTurn}/${summary.hardMaxCallsPerTurn}；压缩只提醒不拒绝。建议先收敛：已完成 / 未完成 / 下一步。`,
    },
  }
}

function callLimitDenyDecision(check) {
  return {
    kind: 'deny',
    reason: `context-guard call-limit: 本轮 bash 调用 ${check.count} 次（session step ${stepLabel(check.step, 'zh')}），达到 ${check.hardMaxCallsPerTurn} 次硬上限；请拆任务或先汇报进展。 ${HARD_LIMIT_DRAFT_MARKER}`,
  }
}

function stepDenyDecision(check, options = {}) {
  if (check.scope === 'session') {
    const revive = options.continueResume === false
      ? ''
      : `；确需在本会话继续，可在输入框回复「继续」恢复 +${options.continueGraceSessionSteps || 30} 步（每次一条，可多次）。`
    const reviveEn = options.continueResume === false
      ? ''
      : ` If you really need this session, reply "continue" to extend it by ${options.continueGraceSessionSteps || 30} steps (one per message, repeatable).`
    const reason = `context-guard step-budget: 本会话累计 ${check.sessionSteps} 步，达到会话硬线 ${check.hardMaxStepsPerSession}；后续工具调用已拒绝。请在最终回复写 3 行交接（已完成 / 未完成 / 下一步）${revive}`
    return {
      kind: 'deny',
      reason,
      displayReason: {
        en: `context-guard step-budget: this session reached ${check.sessionSteps} steps (session hard deny at ${check.hardMaxStepsPerSession}); further tool calls are blocked. Write a 3-line handover (done / todo / next) in your final reply.${reviveEn}`,
        zh: `本会话累计 ${check.sessionSteps} 步，达到会话硬线 ${check.hardMaxStepsPerSession}，后续工具调用已拒绝。请在最终回复写 3 行交接（已完成 / 未完成 / 下一步）${revive}`,
      },
    }
  }
  return {
    kind: 'deny',
    reason: `context-guard step-budget: 本轮 ${check.steps} 步，达到单回合硬线 ${check.hardMaxStepsPerTurn}；请拆任务或先汇报进展。 ${HARD_LIMIT_DRAFT_MARKER}`,
  }
}

const OFFICIAL_FILE_TOOLS = { read: 'read', grep: 'grep', glob: 'glob', discover: null }
const OPS_FILE_TOOLS = { read: 'ops_inspect_local_file', grep: 'ops_grep', glob: 'ops_glob', discover: 'ops_discover_tools' }

/** 读取当前工具面实际发布的文件工具：dsh-ops 的 ops_* 优先，其次官方 read/grep/glob，都没有则返回 null。
 * scope/toolSet 为 DSH 组装系统提示时传入的视图（section 的 text 回调），用于看到本步真实可见的工具。 */
export function detectFileTools(ctx, scope, toolSet) {
  // 必须先走 ctx.get：cordis 上下文未 inject 'tools' 时，直接读 ctx.tools 会抛
  // `cannot get property "tools" without inject`，而 ctx.get 是「without the inject requirement」
  // 的读取方式，取不到只返回 undefined。
  let tools
  try {
    tools = ctx?.get?.('tools') ?? ctx?.tools
  } catch {
    tools = undefined
  }
  const hasFrom = name => {
    try {
      return Boolean(tools?.get?.(name, scope, toolSet))
    } catch {
      return false
    }
  }
  let names = null
  try {
    const definitions = tools?.definitions?.(scope, toolSet)
    if (Array.isArray(definitions) && definitions.length > 0) {
      names = new Set(definitions.map(definition => definition?.name).filter(Boolean))
    }
  } catch {
    names = null
  }
  const has = name => (names ? names.has(name) : hasFrom(name))
  if (has('ops_inspect_local_file')) {
    return { ...OPS_FILE_TOOLS, discover: has('ops_discover_tools') ? 'ops_discover_tools' : null }
  }
  if (has('read')) return OFFICIAL_FILE_TOOLS
  return null
}

export function commandGuidanceText(files) {
  const lines = ['工具使用约束（context-guard）：']
  if (files?.read && files?.grep && files?.glob) {
    lines.push(`- 读取文本文件优先使用 \`${files.read}\`（offset/limit 分段），不要用 cat 整文件读取；搜索用 \`${files.grep}\`，查路径用 \`${files.glob}\`；除非用户明确要求或必须处理非文本文件。`)
  } else {
    lines.push('- 文件读取/搜索工具可能未常驻：先用工具发现（如 `ops_discover_tools`）加载，不要在 shell 里用 cat 或全量 grep 代替。')
  }
  lines.push("- 递归搜索必须带排除；若必须用 shell，加 --glob '!**/node_modules/**' 等，不要直接全量扫描 ~/.dsh 或家目录。")
  lines.push('- 调用 HTTP API 时先用 jq 裁剪字段，或 curl -o /tmp/out.json 落盘后再查询；不要直接输出裸 curl 大响应。')
  if (files?.discover) {
    lines.push(`- 读 PDF/DOCX/CSV 等文档先用 \`${files.discover}\` 选择读取器（ops_read_pdf / ops_read_docx / ops_read_table），不要用 pdftotext 或 python 现场拼。`)
  }
  lines.push('- 只有构建、测试、安装、服务运维等确实需要 shell 的任务才使用 bash；大输出落盘后按路径用文件工具分段读，不要 cat 回去。')
  lines.push('- 违反上述形态的命令会被 context-guard 拒绝；请按拒绝信息中的替代命令重新调用。')
  return lines.join('\n')
}

function registerCommandGuidance(ctx, cfg) {
  if (!cfg.commandLintEnabled || !cfg.commandGuidanceEnabled) return
  try {
    const systemPrompt = ctx.get?.('systemPrompt') ?? ctx.systemPrompt
    if (typeof systemPrompt?.section !== 'function') return
    systemPrompt.section({
      name: 'context-guard:command-guidance',
      order: 490,
      // 按当前工具面渲染：装了 dsh-ops 时提示 ops_*，只有官方工具时提示 read/grep/glob。
      text: ({ scope, toolSet } = {}) => commandGuidanceText(detectFileTools(ctx, scope, toolSet)),
    })
  } catch (error) {
    ctx.logger?.warn?.('context-guard: 注册命令使用提示失败: %s', error)
  }
}

async function guardToolResult(exec, result, decision, cfg, cache, metrics, turnBudget, logger) {
  if (decision.kind !== 'accept') return decision
  if (!cfg.enabled || !cfg.toolNames.includes(exec?.name)) return decision
  if (decision.value !== undefined && !decision.content) return decision

  const text = contentText(decision.content ?? result?.content)
  if (!text) return decision
  const command = commandOf(exec)
  const budget = budgetFor(command, result?.isError, cfg)
  const now = Date.now()
  const sessionId = sessionIdOf(exec)
  const cmdType = classifyCommand(command)
  const cacheable = cfg.dedupEnabled && !result?.isError && text.length >= (Number(cfg.dedupeMinChars) || DEFAULT_DEDUPE_MIN_CHARS)
  const key = cacheable ? dedupKey(sessionId, exec.name, exec.arguments) : null

  const finish = async (out, extra = {}) => {
    const emitted = out?.content ? contentText(out.content).length : text.length
    turnBudget?.consumeOutput(sessionId, emitted)
    if (cfg.metricsEnabled) {
      await metrics.record(metricOf({
        session: sessionId,
        callId: exec.callId,
        tool: exec.name,
        cmdType,
        originalChars: text.length,
        emittedChars: emitted,
        dedup: extra.dedup,
        diffSummary: extra.diffSummary,
        isError: result?.isError,
        archived: extra.archived,
      }))
    }
    maybeCleanup(cfg, sessionId, logger)
    return out
  }

  if (turnBudget?.isExhausted(sessionId) && text.length > cfg.exhaustedOutputChars) {
    try {
      const log = await writeToolLog(cfg.outputDir, sessionId, exec.callId, text)
      const limit = turnBudget.limitsFor(sessionId).maxTurnOutputChars
      const header = `[context-guard:turn-output-limit] ${exec.name} 单轮累计输出已超过 ${limit} chars；本次 ${text.length} chars 已完整落盘：${log.path}\n`
      const footer = `\n[... 本轮后续结果只保留前 ${cfg.exhaustedOutputChars} 字符，完整内容见上方路径 ...]`
      const summary = renderBounded(text, {
        budget: cfg.exhaustedOutputChars,
        header,
        footer,
        headChars: cfg.headChars,
        tailChars: cfg.tailChars,
      })
      return finish({ kind: 'accept', content: [{ type: 'text', text: summary }], ...(decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {}) }, { archived: log.path })
    } catch (error) {
      logger?.warn?.('context-guard: 单轮超限输出落盘失败，保留原结果: %s', error)
    }
  }

  if (key) {
    const previous = cache.get(key, now)
    if (previous) {
      const hash = hashText(text)
      if (previous.hash === hash) {
        cache.touch(key, now)
        const pointer = previous.logPath || `call ${previous.callId}`
        const summary = `[context-guard:dedup] ${exec.name} 输出与 call ${previous.callId} 完全相同（${text.length} chars）\n完整输出: ${pointer}\n[... 重复内容已省略，未重新写入上下文 ...]`
        return finish({ kind: 'accept', content: [{ type: 'text', text: summary }], ...(decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {}) }, { dedup: true, archived: previous.logPath })
      }

      const diff = diffLines(previous.text, text)
      if (diff) {
        let logPath = null
        try {
          const log = await writeToolLog(cfg.outputDir, sessionId, exec.callId, text)
          logPath = log.path
        } catch (error) {
          logger?.warn?.('context-guard: 增量结果落盘失败: %s', error)
        }
        const header = `[context-guard:diff] ${exec.name} 输出与 call ${previous.callId} 不同：-${diff.removedCount} / +${diff.addedCount} 行；类型 ${cmdType}\n完整输出: ${logPath || '(落盘失败)'}\n`
        const footer = '\n[... 仅显示变化块，未变化的上下文已省略 ...]'
        const summary = renderBounded(diff.summary, {
          budget,
          header,
          footer,
          headChars: cfg.headChars,
          tailChars: cfg.tailChars,
        })
        cache.set(key, { hash: hashText(text), text, callId: exec.callId, logPath }, now)
        return finish({ kind: 'accept', content: [{ type: 'text', text: summary }], ...(decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {}) }, { diffSummary: true, archived: logPath })
      }
    }
  }

  if (text.length <= budget) {
    if (key) cache.set(key, { hash: hashText(text), text, callId: exec.callId, logPath: null }, now)
    return finish(decision)
  }

  try {
    const log = await writeToolLog(cfg.outputDir, sessionId, exec.callId, text)
    const header = `[context-guard] ${exec.name} 输出 ${text.length} chars，超过 ${budget} 预算；类型 ${cmdType}${result?.isError ? '；错误结果' : ''}\n完整输出: ${log.path}\n`
    const footer = '\n[... 中间已裁剪，完整内容见上方路径 ...]'
    const summary = renderBounded(text, {
      budget,
      header,
      footer,
      headChars: cfg.headChars,
      tailChars: cfg.tailChars,
    })
    if (key) cache.set(key, { hash: hashText(text), text, callId: exec.callId, logPath: log.path }, now)
    return finish({ kind: 'accept', content: [{ type: 'text', text: summary }], ...(decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {}) }, { archived: log.path })
  } catch (error) {
    logger?.warn?.('context-guard: 工具输出落盘失败，保留原结果: %s', error)
    return finish(decision)
  }
}


function sendJson(res, status, body) {
  if (res.headersSent || res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** 审批卡「始终允许」的 host 端点：客户端仅提交短期 token，避免回传/伪造命令正文。 */
export function createRiskRuleHandler({ store, pending, riskAllowHosts, logger }) {
  return (req, res) => {
    if (req.method === 'GET') {
      void store.list()
        .then(rules => sendJson(res, 200, { ok: true, rules }))
        .catch(error => {
          logger?.warn?.('context-guard: 读取风险规则失败: %s', error)
          sendJson(res, 500, { ok: false, error: 'rule-store-unavailable' })
        })
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    let body = ''
    req.on('data', chunk => {
      body += chunk.toString('utf8')
      if (body.length > 16 * 1024) req.destroy()
    })
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body)
        if (parsed?.action === 'allow') {
          // 原因先校验再消费 token：缺原因时用户仍可重试，不浪费待放行项。
          const reason = normalizeRuleReason(parsed.reason)
          if (!reason) {
            sendJson(res, 400, { ok: false, error: 'reason-required' })
            return
          }
          // 范围只接受 auto（按类别收窄）与 command（仅整条命令），其它值按坏请求处理，同样不消费 token。
          const scope = parsed.scope === undefined ? 'auto' : String(parsed.scope)
          if (scope !== 'auto' && scope !== 'command') {
            sendJson(res, 400, { ok: false, error: 'invalid-scope' })
            return
          }
          await pending.load()
          const entry = pending.take(parsed.token) || pending.takeByCallId(parsed.callId)
          if (!entry) {
            sendJson(res, 410, { ok: false, error: 'approval-rule-expired' })
            return
          }
          const cwd = typeof entry.cwd === 'string' ? entry.cwd : undefined
          let risk = analyzeCommand(entry.command, { allowHosts: riskAllowHosts })
          if (risk.risk) {
            await store.load()
            const effectiveHosts = effectiveAllowHosts(riskAllowHosts, store)
            // 与 pre-execute 同源：卡片已按已保存 host 规则收窄，落库也只写仍未放行的主机。
            if (store.allowedHosts().length > 0) {
              risk = analyzeCommand(entry.command, { allowHosts: effectiveHosts })
            }
            // 已保存的 command/artifact 规则再次放行时保留原有「更新原因」语义，不提前返回 409；
            // host 维度已由有效名单收窄，这里只对没有非 host 规则命中的命令做最终过滤。
            if (!store.matchesCommand(entry.command) && !store.matchesArtifactRm(entry.command) &&
              !store.matchesArtifactFind(entry.command)) {
              risk = filterRiskByRules(risk, entry.command, store, effectiveHosts, cwd)
            }
          }
          if (!risk.risk) {
            sendJson(res, 409, { ok: false, error: 'command-no-longer-risky' })
            return
          }
          const specs = ruleSpecsFor(entry.command, risk, Date.now(), { scope, cwd }).map(spec => ({ ...spec, reason }))
          if (specs.length === 0) {
            sendJson(res, 400, { ok: false, error: 'no-rule-parsed' })
            return
          }
          const rules = await store.add(specs)
          sendJson(res, 200, { ok: true, rules })
          return
        }
        if (parsed?.action === 'revoke') {
          const removed = await store.revoke(parsed.id)
          sendJson(res, removed ? 200 : 404, { ok: removed })
          return
        }
        sendJson(res, 400, { ok: false, error: 'unknown-action' })
      } catch (error) {
        logger?.warn?.('context-guard: 风险规则请求失败: %s', error)
        sendJson(res, 400, { ok: false, error: 'invalid-request' })
      }
    })
    req.on('error', () => sendJson(res, 400, { ok: false, error: 'invalid-request' }))
  }
}

export function apply(ctx, config = {}) {
  const dir = typeof config.dir === 'string' && config.dir ? config.dir : undefined
  const cfg = guardConfig(config)
  const riskRuleStore = new RiskRuleStore(cfg.riskRuleFile)
  const pendingRiskRules = new PendingRiskRules({
    file: join(dirname(cfg.riskRuleFile), 'risk-pending.json'),
    onError: error => ctx.logger?.warn?.('context-guard: 待放行项读写失败（不影响本次审批）: %s', error),
  })
  if (cfg.riskAutoAllowEnabled) {
    void riskRuleStore.load().catch(error => ctx.logger?.warn?.('context-guard: 加载风险规则失败: %s', error))
    void pendingRiskRules.load().catch(error => ctx.logger?.warn?.('context-guard: 加载待放行项失败: %s', error))
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], routeCtx => {
        routeCtx.effect(() => routeCtx.webServer.register({
          kind: 'exact',
          path: RISK_RULE_ENDPOINT,
          handler: createRiskRuleHandler({
            store: riskRuleStore,
            pending: pendingRiskRules,
            riskAllowHosts: cfg.riskAllowHosts,
            logger: ctx.logger,
          }),
        }), 'context-guard: risk allow-rule route')
      })
    }
  }
  const cache = new DedupCache({ ttlMs: cfg.dedupTtlMs, maxEntries: cfg.dedupMaxEntries })
  const metrics = new MetricsRecorder(cfg.metricsDir, { logger: ctx.logger })
  registerCommandGuidance(ctx, cfg)
  const budgetRules = compileBudgetRules(cfg.sessionBudgets)
  const titleCache = new SessionTitleCache({ ttlMs: cfg.sessionTitleTtlMs })
  const dispatchRegistry = new DispatchRegistry({ windowMs: cfg.dispatchGuard.windowMs })
  /** 命中预算规则的会话（核验态）返回规则，否则 null；同时把标题写进缓存供 turnBudget 使用。 */
  const sessionRuleFor = exec => {
    if (budgetRules.length === 0) return null
    return matchBudget(budgetRules, sessionTitleOf(ctx, exec, titleCache))
  }
  const turnBudget = new TurnBudget({
    maxCallsPerTurn: cfg.maxCallsPerTurn,
    hardMaxCallsPerTurn: cfg.hardMaxCallsPerTurn,
    maxTurnOutputChars: cfg.maxTurnOutputChars,
    exhaustedOutputChars: cfg.exhaustedOutputChars,
    maxStepsPerTurn: cfg.stepBudget.maxStepsPerTurn,
    hardMaxStepsPerTurn: cfg.stepBudget.hardMaxStepsPerTurn,
    maxStepsPerSession: cfg.stepBudget.maxStepsPerSession,
    hardMaxStepsPerSession: cfg.stepBudget.hardMaxStepsPerSession,
    maxCompactions: cfg.stepBudget.maxCompactions,
    hardMaxCompactions: cfg.stepBudget.hardMaxCompactions,
    continueGraceSessionSteps: cfg.stepBudget.continueGraceSessionSteps,
    budgetFor: sessionId => {
      const title = titleCache.read(sessionId)
      return title === undefined ? null : matchBudget(budgetRules, title)
    },
    logger: ctx.logger,
  })
  if (cfg.cleanupEnabled) {
    void cleanupOutputs(cfg.outputDir, { ...cfg.cleanup }).catch(error => ctx.logger?.warn?.('context-guard: 启动清理失败: %s', error))
  }

  ctx.on('session/event', (session, event) => {
    if (event.type === 'user/message') {
      if (!cfg.stepBudget.enabled || !cfg.stepBudget.continueResume) return
      // 只认真人输入（source.kind === 'user'）；子任务/团队消息/系统注入不解除会话硬线。
      if (event.data?.source?.kind !== 'user') return
      const text = userText(event)
      if (!isContinueText(text, cfg.stepBudget.continueKeywords)) return
      const resumed = turnBudget.resumeByUser(session?.id || 'unknown-session')
      if (resumed.resumed) {
        ctx.logger?.info?.('context-guard: 用户回复「继续」，会话硬线恢复到 %s 步: %s',
          resumed.hardMaxStepsPerSession, session?.id || 'unknown-session')
      }
      return
    }
    if (event.type === 'turn/start') {
      turnBudget.startTurn(session?.id || 'unknown-session', event.data?.turn)
      return
    }
    if (event.type === 'step/start') {
      turnBudget.noteStep(session?.id || 'unknown-session', event.data?.step)
      return
    }
    if (event.type === 'compaction/start') {
      void writeArchive(session, '压缩前快照（摘要尚未生成）', '', {
        trigger: event.data?.sourceCommandId ? 'manual' : 'automatic',
      }, dir).catch(error => ctx.logger?.warn?.('context-guard: 写压缩前快照失败: %s', error))
      return
    }
    if (event.type !== 'compaction/summary') return
    const summary = textOf(event.data?.summary)
    const compaction = turnBudget.noteCompaction(session?.id || 'unknown-session', event.seq)
    if (compaction.action !== 'allow') {
      ctx.logger?.warn?.(
        'context-guard: 本会话已压缩 %s 次（提醒点 %s / 硬线 %s），压缩只提醒不拒绝工具；建议先收敛结论或写交接',
        compaction.compactions, compaction.maxCompactions, compaction.hardMaxCompactions,
      )
    }
    void writeArchive(session, '压缩完成', summary, {
      trigger: event.data?.sourceCommandId ? 'manual' : 'automatic',
      shadowedTokenCount: event.data?.shadowedTokenCount,
      provider: event.data?.provider,
      model: event.data?.model,
    }, dir).catch(error => ctx.logger?.warn?.('context-guard: 写压缩摘要失败: %s', error))
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (decision.kind !== 'allow') return decision
    if (!cfg.enabled) return decision

    // 步数/压缩门禁最先判定：压缩只提醒不拒绝；回合/会话硬线只允许收尾交接，不再放行任何工具。
    const asks = []
    if (cfg.stepBudget.enabled) {
      const budgetSession = sessionIdOf(exec)
      const compaction = turnBudget.checkCompaction(budgetSession)
      if (compaction.warning && compaction.compactions === compaction.hardMaxCompactions) {
        ctx.logger?.warn?.('context-guard: 本会话已压缩 %s 次（硬线 %s），仍放行工具；建议先收敛结论或写交接',
          compaction.compactions, compaction.hardMaxCompactions)
      }
      const step = turnBudget.checkStep(budgetSession)
      if (step.action === 'deny') {
        ctx.logger?.info?.('context-guard: %s步数硬线拦截: %s', step.scope === 'session' ? '会话' : '回合', budgetSession)
        return stepDenyDecision(step, cfg.stepBudget)
      }
      if (step.action === 'ask') asks.push(budgetAskDecision(turnBudget.summary(budgetSession), step.scope))
    }

    // 派单去重：只有 prompt 声明了「快照：<sha>」才参与，普通子任务不受影响。
    if (cfg.dispatchGuard.enabled && cfg.dispatchTools.includes(exec?.name)) {
      const prompt = promptOf(exec)
      const fingerprint = snapshotFingerprint(prompt)
      const verdict = dispatchRegistry.claim(sessionIdOf(exec), fingerprint, {
        overrideToken: cfg.dispatchGuard.overrideToken,
        prompt,
      })
      if (verdict.duplicate) {
        ctx.logger?.info?.('context-guard: 拦截重复派单 (%s): %s', fingerprint, sessionIdOf(exec))
        return dispatchDuplicateDecision(fingerprint, verdict.firstAt)
      }
    }

    // 核验态：标题命中 sessionBudgets 后只读 + 预算收紧，限制在 checkCall 处生效。
    const rule = sessionRuleFor(exec)
    if (rule && rule.denyTools.includes(exec?.name)) {
      ctx.logger?.info?.('context-guard: 核验态拦截工具 (%s): %s', exec?.name, sessionIdOf(exec))
      return verifyDenyToolDecision(rule, exec?.name)
    }

    const command = commandOf(exec) || (exec?.name === 'web_fetch' && typeof exec?.arguments?.url === 'string'
      ? `curl ${exec.arguments.url}`
      : '')
    if (!command) return asks.length > 0 ? mergeAskDecisions(asks) : decision
    if (rule && rule.denyCommandRes.some(re => re.test(command))) {
      ctx.logger?.info?.('context-guard: 核验态拦截破坏性命令: %s', sessionIdOf(exec))
      return verifyDenyCommandDecision(rule, command)
    }

    // 临时清理规则按 cwd 生效：与 docGuard 一样优先取工具参数里的工作目录。
    const riskCwd = exec?.arguments?.cwd || exec?.arguments?.workdir || exec?.cwd || undefined
    if (cfg.riskCheckEnabled && cfg.riskToolNames.includes(exec?.name)) {
      let risk = analyzeCommand(command, { allowHosts: cfg.riskAllowHosts })
      if (risk.risk && cfg.riskAutoAllowEnabled) {
        try {
          await riskRuleStore.load()
          const effectiveHosts = effectiveAllowHosts(cfg.riskAllowHosts, riskRuleStore)
          // 已保存的 host 规则参与后续链接检查：卡片只列仍未放行的主机，
          // 下游 pendingRiskRules/ruleSpecsFor 的落库范围随之收窄。
          if (riskRuleStore.allowedHosts().length > 0) {
            risk = analyzeCommand(command, { allowHosts: effectiveHosts })
          }
          risk = filterRiskByRules(risk, command, riskRuleStore, effectiveHosts, riskCwd)
          if (!risk.risk) ctx.logger?.info?.('context-guard: 命中已放行规则: %s', risk.allowedBy || 'host')
        } catch (error) {
          ctx.logger?.warn?.('context-guard: 风险规则匹配失败，保持询问: %s', error)
        }
      }
      if (risk.risk) {
        ctx.logger?.info?.('context-guard: 风险命令待确认 (%s): %s', risk.level, risk.preview)
        const ask = riskAskDecision(risk)
        if (cfg.riskAutoAllowEnabled) {
          const token = pendingRiskRules.add(command, risk, exec?.callId, riskCwd)
          ask.reason = `${ask.reason}; rule-token: ${token}`
        }
        asks.push(ask)
      }
    }
    if (cfg.commandLintEnabled && cfg.toolNames.includes(exec?.name)) {
      // 传 exec.agent 作 scope：ops_* 按 agent 作用域注册，全局视图看不到，
      // 不传会退化成官方的 read/grep/glob，替代命令提示就指错工具。
      const lint = lintCommand(command, detectFileTools(ctx, exec?.agent))
      if (lint.hit) {
        ctx.logger?.info?.('context-guard: 命令形态拦截 (%s): %s', cfg.commandLintMode, lint.reasons.map(reason => reason.code).join(', '))
        const verdict = lintDecision(lint, command, cfg.commandLintMode)
        if (verdict.kind === 'deny') return verdict
        asks.push(verdict)
      }
    }
    if (cfg.docGuardEnabled && cfg.toolNames.includes(exec?.name)) {
      const docDecision = await docGuardDecision(command, cfg, ctx.logger, { cwd: exec?.arguments?.cwd || exec?.cwd })
      if (docDecision?.kind === 'deny') return docDecision
    }
    if (cfg.toolNames.includes(exec?.name)) {
      const check = turnBudget.checkCall(sessionIdOf(exec))
      if (check.action === 'deny') return callLimitDenyDecision(check)
      if (check.action === 'ask') asks.push(budgetAskDecision(turnBudget.summary(sessionIdOf(exec)), null))
    }
    if (asks.length > 0) return mergeAskDecisions(asks)
    return decision
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    return guardToolResult(exec, result, decision, cfg, cache, metrics, turnBudget, ctx.logger)
  })
}
