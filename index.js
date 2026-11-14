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
  return {
    enabled: config.enabled !== false,
    toolNames: Array.isArray(config.toolNames) && config.toolNames.length > 0 ? config.toolNames : DEFAULT_TOOL_NAMES,
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
  }
}

async function guardToolResult(exec, result, decision, cfg, cache, logger) {
  if (decision.kind !== 'accept') return decision
  if (!cfg.enabled || !cfg.toolNames.includes(exec?.name)) return decision
  if (decision.value !== undefined && !decision.content) return decision

  const text = contentText(decision.content ?? result?.content)
  if (!text) return decision
  const command = commandOf(exec)
  const budget = budgetFor(command, result?.isError, cfg)
  const now = Date.now()
  const sessionId = sessionIdOf(exec)
  const cacheable = cfg.dedupEnabled && !result?.isError && text.length >= (Number(cfg.dedupeMinChars) || DEFAULT_DEDUPE_MIN_CHARS)
  const key = cacheable ? dedupKey(sessionId, exec.name, exec.arguments) : null

  if (key) {
    const previous = cache.get(key, now)
    if (previous) {
      const hash = hashText(text)
      if (previous.hash === hash) {
        cache.touch(key, now)
        const pointer = previous.logPath || `call ${previous.callId}`
        const summary = `[context-guard:dedup] ${exec.name} 输出与 call ${previous.callId} 完全相同（${text.length} chars）\n完整输出: ${pointer}\n[... 重复内容已省略，未重新写入上下文 ...]`
        return { kind: 'accept', content: [{ type: 'text', text: summary }], ...(decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {}) }
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
        const header = `[context-guard:diff] ${exec.name} 输出与 call ${previous.callId} 不同：-${diff.removedCount} / +${diff.addedCount} 行；类型 ${classifyCommand(command)}\n完整输出: ${logPath || '(落盘失败)'}\n`
        const footer = '\n[... 仅显示变化块，未变化的上下文已省略 ...]'
        const summary = renderBounded(diff.summary, {
          budget,
          header,
          footer,
          headChars: cfg.headChars,
          tailChars: cfg.tailChars,
        })
        cache.set(key, { hash: hashText(text), text, callId: exec.callId, logPath }, now)
        return { kind: 'accept', content: [{ type: 'text', text: summary }], ...(decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {}) }
      }
    }
  }

  if (text.length <= budget) {
    if (key) cache.set(key, { hash: hashText(text), text, callId: exec.callId, logPath: null }, now)
    return decision
  }

  try {
    const log = await writeToolLog(cfg.outputDir, sessionId, exec.callId, text)
    const category = classifyCommand(command)
    const header = `[context-guard] ${exec.name} 输出 ${text.length} chars，超过 ${budget} 预算；类型 ${category}${result?.isError ? '；错误结果' : ''}\n完整输出: ${log.path}\n`
    const footer = '\n[... 中间已裁剪，完整内容见上方路径 ...]'
    const summary = renderBounded(text, {
      budget,
      header,
      footer,
      headChars: cfg.headChars,
      tailChars: cfg.tailChars,
    })
    if (key) cache.set(key, { hash: hashText(text), text, callId: exec.callId, logPath: log.path }, now)
    return { kind: 'accept', content: [{ type: 'text', text: summary }], ...(decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {}) }
  } catch (error) {
    logger?.warn?.('context-guard: 工具输出落盘失败，保留原结果: %s', error)
    return decision
  }
}

export function apply(ctx, config = {}) {
  const dir = typeof config.dir === 'string' && config.dir ? config.dir : undefined
  const cfg = guardConfig(config)
  const cache = new DedupCache({ ttlMs: cfg.dedupTtlMs, maxEntries: cfg.dedupMaxEntries })

  ctx.on('session/event', (session, event) => {
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

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    return guardToolResult(exec, result, decision, cfg, cache, ctx.logger)
  })
}
