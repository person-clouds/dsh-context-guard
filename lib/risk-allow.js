/** 风险命令放行规则：把用户确认过的命令解析成可复核的窄规则。
 *
 * 规则只有两类：
 * - command：完全相同（规范化空白后）的命令，哈希匹配；
 * - host：用户放行未知链接时只记住该主机，其它风险规则仍独立生效。
 *
 * 不做通配符、不按规则代码全量放行，避免一次确认放大成过宽权限。
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DEFAULT_ALLOW_HOSTS, extractUrls, hostOf, isAllowedHost, normalizeCommand } from './risk.js'

export const RISK_RULE_ENDPOINT = '/api/context-guard-risk-rule'
export const RISK_RULE_TOKEN_RE = /rule-token:\s*([a-f0-9]{16,64})/
export const MAX_RULES = 200
export const MAX_COMMAND_LENGTH = 4000

const HOST_REASON_CODES = new Set(['unknown-link', 'insecure-http'])

function hashCommand(command) {
  return createHash('sha256').update(normalizeCommand(command)).digest('hex')
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

/** 生成规则描述；纯函数，便于测试 route 之外的解析逻辑。 */
export function ruleSpecsFor(command, risk, now = Date.now()) {
  const raw = String(command || '')
  if (!raw.trim() || raw.length > MAX_COMMAND_LENGTH) return []
  const reasons = Array.isArray(risk?.reasons) ? risk.reasons : []
  if (reasons.length === 0) return []
  const codes = unique(reasons.map(reason => reason.code))
  const level = risk.level || 'medium'
  const preview = raw.replace(/\s+/g, ' ').slice(0, 300)
  const onlyLinkReasons = reasons.every(reason => HOST_REASON_CODES.has(reason.code))
  if (onlyLinkReasons) {
    const hosts = unique(extractUrls(raw).map(hostOf))
    if (hosts.length > 0) {
      return hosts.map(host => ({
        kind: 'host',
        key: host,
        host,
        level,
        codes,
        preview,
        createdAt: now,
      }))
    }
  }
  const hash = hashCommand(raw)
  return [{
    kind: 'command',
    key: hash,
    hash,
    command: normalizeCommand(raw),
    level,
    codes,
    preview,
    createdAt: now,
  }]
}

/** 为一条待审批命令生成短期 token，客户端只回传 token，不直接提交命令正文。 */
export class PendingRiskRules {
  constructor({ ttlMs = 10 * 60 * 1000, maxEntries = 100, now = Date.now } = {}) {
    this.ttlMs = ttlMs
    this.maxEntries = maxEntries
    this.now = now
    this.entries = new Map()
  }

  add(command, risk) {
    this.cleanup()
    const token = randomBytes(12).toString('hex')
    this.entries.set(token, { command: String(command || ''), risk, at: this.now() })
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      this.entries.delete(oldest)
    }
    return token
  }

  take(token) {
    this.cleanup()
    const key = String(token || '')
    const entry = this.entries.get(key)
    if (!entry) return null
    this.entries.delete(key)
    return entry
  }

  cleanup() {
    const now = this.now()
    for (const [key, entry] of this.entries) {
      if (now - entry.at > this.ttlMs) this.entries.delete(key)
    }
  }
}

/** 从审批 reason 中提取 token；不把正文回传给浏览器。 */
export function tokenOfReason(reason) {
  const match = RISK_RULE_TOKEN_RE.exec(String(reason || ''))
  return match ? match[1] : null
}

function publicRule(rule) {
  return {
    id: rule.id,
    kind: rule.kind,
    level: rule.level,
    codes: [...rule.codes],
    preview: rule.preview,
    ...(rule.kind === 'host' ? { host: rule.host } : {}),
    createdAt: rule.createdAt,
  }
}

/** JSON 规则文件；读写串行化，写入失败不替换内存快照。 */
export class RiskRuleStore {
  constructor(file, { now = Date.now } = {}) {
    this.file = file
    this.now = now
    this.rules = []
    this.loaded = false
    this.loading = undefined
    this.queue = Promise.resolve()
  }

  async load() {
    if (this.loaded) return this.rules
    if (!this.loading) {
      this.loading = (async () => {
        try {
          const text = await readFile(this.file, 'utf8')
          const parsed = JSON.parse(text)
          this.rules = Array.isArray(parsed?.rules) ? parsed.rules.filter(validRule) : []
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
          this.rules = []
        }
        this.loaded = true
        return this.rules
      })()
    }
    return this.loading
  }

  async list() {
    await this.load()
    return this.rules.map(publicRule)
  }

  async add(specs) {
    await this.load()
    const write = this.queue.then(async () => {
      const now = this.now()
      const added = []
      for (const spec of specs) {
        const existing = this.rules.find(rule => rule.kind === spec.kind && rule.key === spec.key)
        if (existing) {
          existing.lastUsedAt = now
          added.push(existing)
          continue
        }
        const rule = {
          ...spec,
          id: `${spec.kind}:${String(spec.key).slice(0, 24)}`,
          createdAt: spec.createdAt || now,
          lastUsedAt: now,
        }
        this.rules.push(rule)
        added.push(rule)
      }
      if (this.rules.length > MAX_RULES) this.rules = this.rules.slice(-MAX_RULES)
      await this.persist()
      return added.map(publicRule)
    })
    this.queue = write.catch(() => {})
    return write
  }

  async revoke(id) {
    await this.load()
    const write = this.queue.then(async () => {
      const before = this.rules.length
      this.rules = this.rules.filter(rule => rule.id !== String(id || ''))
      if (this.rules.length !== before) await this.persist()
      return before !== this.rules.length
    })
    this.queue = write.catch(() => {})
    return write
  }

  async persist() {
    const text = JSON.stringify({ version: 1, rules: this.rules }, null, 2) + '\n'
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    const temp = `${this.file}.${process.pid}.tmp`
    await writeFile(temp, text, { encoding: 'utf8', mode: 0o600 })
    await rename(temp, this.file)
  }

  matchesCommand(command) {
    const hash = hashCommand(command)
    return this.rules.some(rule => rule.kind === 'command' && rule.hash === hash)
  }

  allowedHosts() {
    return this.rules.filter(rule => rule.kind === 'host').map(rule => rule.host)
  }
}

function validRule(rule) {
  return rule && typeof rule === 'object' &&
    (rule.kind === 'command' || rule.kind === 'host') &&
    typeof rule.key === 'string' && typeof rule.id === 'string'
}

/** 按已保存规则过滤风险原因；只移除用户明确放行过的精确命令或主机链接。 */
export function filterRiskByRules(risk, command, store, allowHosts) {
  if (!risk?.risk) return risk
  if (store.matchesCommand(command)) {
    return { ...risk, risk: false, level: 'none', reasons: [], allowedBy: 'command' }
  }
  const ruleHosts = store.allowedHosts()
  if (ruleHosts.length === 0) return risk
  const urls = extractUrls(command)
  if (urls.length === 0) return risk
  const baseHosts = Array.isArray(allowHosts) && allowHosts.length > 0 ? allowHosts : DEFAULT_ALLOW_HOSTS
  const allHostsAllowed = urls.every(url => {
    const host = hostOf(url)
    return isAllowedHost(host, baseHosts) || isAllowedHost(host, ruleHosts)
  })
  if (!allHostsAllowed) return risk
  const reasons = risk.reasons.filter(reason => !HOST_REASON_CODES.has(reason.code))
  if (reasons.length === risk.reasons.length) return risk
  const level = reasons.some(reason => reason.level === 'high') ? 'high'
    : reasons.some(reason => reason.level === 'medium') ? 'medium' : 'none'
  return { ...risk, risk: reasons.length > 0, level, reasons, allowedBy: 'host' }
}
