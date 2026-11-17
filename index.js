/**
 * DSH context guard：工具输出预算/落盘、重复结果去重、只读诊断与压缩归档。
 *
 * - `tools/post-execute`：bash 输出超预算时完整落盘，上下文只留 head/tail/路径；
 * - `session/event`：压缩前写快照，压缩后把 DSH 结构化摘要写成 STATUS.md；
 * - 不额外调用模型，不改变压缩阈值，写入失败只 warning。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { commandOf, dshHome, hashText, safeName, sessionIdOf, textOf as contentText } from './lib/common.js'
import { budgetFor, classifyCommand, renderBounded } from './lib/budget.js'
import { writeToolLog } from './lib/archive.js'
import { DEFAULT_DEDUPE_MIN_CHARS, DedupCache, dedupKey, diffLines } from './lib/dedup.js'
import { MetricsRecorder, metricOf } from './lib/metrics.js'
import { cleanupOutputs } from './lib/cleanup.js'
import { analyzeCommand, riskAskDecision } from './lib/risk.js'
import { lintCommand, lintDecision } from './lib/command-lint.js'
import { TurnBudget } from './lib/turn-budget.js'

export const name = 'dsh-context-guard'

const DEFAULT_TOOL_NAMES = ['bash', 'persistent-bash', 'terminal-bash']

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

function iso(ms) {
  return new Date(ms || Date.now()).toISOString()
}

function fence(text) {
  return '```\n' + String(text).replaceAll('```', '``\u200b`') + '\n```'
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
  const root = dir || join(dshHome(), 'compaction-archive')
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
    commandLintEnabled: config.commandLintEnabled !== false,
    commandLintMode: config.commandLintMode === 'ask' ? 'ask' : 'deny',
    commandGuidanceEnabled: config.commandGuidanceEnabled !== false,
    maxCallsPerTurn: Number(config.maxCallsPerTurn) || 20,
    hardMaxCallsPerTurn: Number(config.hardMaxCallsPerTurn) || 40,
    maxTurnOutputChars: Number(config.maxTurnOutputChars) || 40000,
    exhaustedOutputChars: Number(config.exhaustedOutputChars) || 800,
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

function callLimitAskDecision(check) {
  return {
    kind: 'ask',
    reason: `context-guard call-limit: 本轮已 ${check.maxCallsPerTurn} 次 bash，是否继续（第 ${check.count} 次）`,
    displayReason: {
      en: `This turn has already used ${check.maxCallsPerTurn} bash calls. Continue with call ${check.count} of at most ${check.hardMaxCallsPerTurn}?`,
      zh: `本轮已 ${check.maxCallsPerTurn} 次 bash 调用，是否继续？
当前是第 ${check.count} 次；第 ${check.hardMaxCallsPerTurn} 次起会拒绝执行。建议合并命令、改用 inspect.sh，或先汇报进展。`,
    },
  }
}

function callLimitDenyDecision(check) {
  return {
    kind: 'deny',
    reason: `context-guard call-limit: 本轮已 ${check.count} 次 bash，达到 ${check.hardMaxCallsPerTurn} 次硬上限；请拆任务或先汇报进展。`,
  }
}

const COMMAND_GUIDANCE = [
  '工具使用约束（context-guard）：',
  '- 读取文本文件优先使用 read 工具（offset/limit 分段），不要用 cat 整文件读取；除非用户明确要求或必须处理非文本文件。',
  "- 递归搜索优先使用 grep/glob 工具；若必须用 shell，必须加 --glob '!**/node_modules/**' 等排除，不要直接全量扫描 ~/.dsh 或家目录。",
  "- 调用 HTTP API 时先用 jq 裁剪字段，或 curl -o /tmp/out.json 落盘后再查询；不要直接输出裸 curl 大响应。",
  '- 只有构建、测试、安装、服务运维等确实需要 shell 的任务才使用 bash。',
  '- 违反上述形态的命令会被 context-guard 拒绝；请按拒绝信息中的替代命令重新调用。',
].join('\n')

function registerCommandGuidance(ctx, cfg) {
  if (!cfg.commandLintEnabled || !cfg.commandGuidanceEnabled) return
  try {
    const systemPrompt = ctx.systemPrompt ?? ctx.get?.('systemPrompt')
    if (typeof systemPrompt?.section !== 'function') return
    systemPrompt.section({
      name: 'context-guard:command-guidance',
      order: 490,
      text: COMMAND_GUIDANCE,
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
      const header = `[context-guard:turn-output-limit] ${exec.name} 单轮累计输出已超过 ${turnBudget.maxTurnOutputChars} chars；本次 ${text.length} chars 已完整落盘：${log.path}\n`
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

export function apply(ctx, config = {}) {
  const dir = typeof config.dir === 'string' && config.dir ? config.dir : undefined
  const cfg = guardConfig(config)
  const cache = new DedupCache({ ttlMs: cfg.dedupTtlMs, maxEntries: cfg.dedupMaxEntries })
  const metrics = new MetricsRecorder(cfg.metricsDir, { logger: ctx.logger })
  registerCommandGuidance(ctx, cfg)
  const turnBudget = new TurnBudget({
    maxCallsPerTurn: cfg.maxCallsPerTurn,
    hardMaxCallsPerTurn: cfg.hardMaxCallsPerTurn,
    maxTurnOutputChars: cfg.maxTurnOutputChars,
    exhaustedOutputChars: cfg.exhaustedOutputChars,
    logger: ctx.logger,
  })
  if (cfg.cleanupEnabled) {
    void cleanupOutputs(cfg.outputDir, { ...cfg.cleanup }).catch(error => ctx.logger?.warn?.('context-guard: 启动清理失败: %s', error))
  }

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      turnBudget.startTurn(session?.id || 'unknown-session', event.data?.turn)
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
    const command = commandOf(exec) || (exec?.name === 'web_fetch' && typeof exec?.arguments?.url === 'string'
      ? `curl ${exec.arguments.url}`
      : '')
    if (!command) return decision

    const asks = []
    if (cfg.riskCheckEnabled && cfg.riskToolNames.includes(exec?.name)) {
      const risk = analyzeCommand(command, { allowHosts: cfg.riskAllowHosts })
      if (risk.risk) {
        ctx.logger?.info?.('context-guard: 风险命令待确认 (%s): %s', risk.level, risk.preview)
        asks.push(riskAskDecision(risk))
      }
    }
    if (cfg.commandLintEnabled && cfg.toolNames.includes(exec?.name)) {
      const lint = lintCommand(command)
      if (lint.hit) {
        ctx.logger?.info?.('context-guard: 命令形态拦截 (%s): %s', cfg.commandLintMode, lint.reasons.map(reason => reason.code).join(', '))
        const verdict = lintDecision(lint, command, cfg.commandLintMode)
        if (verdict.kind === 'deny') return verdict
        asks.push(verdict)
      }
    }
    if (cfg.toolNames.includes(exec?.name)) {
      const check = turnBudget.checkCall(sessionIdOf(exec))
      if (check.action === 'deny') return callLimitDenyDecision(check)
      if (check.action === 'ask') asks.push(callLimitAskDecision(check))
    }
    if (asks.length > 0) return mergeAskDecisions(asks)
    return decision
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    return guardToolResult(exec, result, decision, cfg, cache, metrics, turnBudget, ctx.logger)
  })
}
