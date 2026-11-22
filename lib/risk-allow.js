/** 风险命令放行规则：把用户确认过的命令解析成可复核的窄规则。
 *
 * 规则分三类：
 * - artifact-rm / artifact-find：同一项目前缀下删除构建产物目录（node_modules/dist/build/.cache 等），
 *   这是唯一会跨命令参数泛化的类别规则；
 * - host：用户放行未知链接时只记住该主机，其它风险规则仍独立生效；
 * - command：无法归入安全类时，退化为完全相同的规范化命令哈希。
 *
 * 不做通配符、不按规则代码全量放行，避免一次确认放大成过宽权限。
 * 每条规则可带 `reason`：用户在「始终允许」时填写的放行原因，仅作标记，不参与匹配。
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DEFAULT_ALLOW_HOSTS, extractFetchUrls, hasOpaqueFetch, hostOf, isAllowedHost, normalizeCommand, shellTokens, splitShellSegments } from './risk.js'
import { DEFAULT_ALLOWLIST } from './default-allowlist.js'

export const RISK_RULE_ENDPOINT = '/api/context-guard-risk-rule'
export const RISK_RULE_TOKEN_RE = /rule-token:\s*([a-f0-9]{16,64})/
export const MAX_RULES = 200
export const MAX_COMMAND_LENGTH = 4000
export const MAX_RULE_REASON_LENGTH = 200

const HOST_REASON_CODES = new Set(['unknown-link', 'insecure-http'])

/** 可安全重建的构建产物目录；只按路径段匹配，不做子串匹配。来自随包默认配置。 */
const ARTIFACT_DIR_NAMES = DEFAULT_ALLOWLIST.rm.artifactDirs

function pathClassOf(target) {
  let raw = String(target || '').replace(/\/+$/, '')
  let glob = false
  if (raw.endsWith('/*')) {
    glob = true
    raw = raw.slice(0, -2).replace(/\/+$/, '')
  }
  if (!raw || raw.includes('*') || raw.includes('?') || raw.includes('[') ||
    raw.includes(']') || raw.includes('{') || raw.includes('}') || raw.includes('(') ||
    raw.includes(')') || raw.includes('!') || raw.includes('`') || raw.includes('$') ||
    raw.includes('\\') || raw.includes('<') || raw.includes('>')) return null
  let root = 'rel'
  let body = raw
  if (raw.startsWith('/')) {
    root = 'abs'
    body = raw.slice(1)
  } else if (raw === '~' || raw.startsWith('~/')) {
    root = 'home'
    body = raw.slice(raw === '~' ? 1 : 2)
  } else if (raw.startsWith('./')) {
    body = raw.slice(2)
  }
  const parts = body.split('/').filter(part => part && part !== '.')
  if (parts.length === 0 || parts.some(part => part === '..')) return null
  const artifactIndex = parts.findIndex(part => ARTIFACT_DIR_NAMES.has(part))
  if (artifactIndex < 0) return null
  // 绝对路径至少保留一级项目前缀，避免把 /node_modules 这类根目录规则放大。
  if (root === 'abs' && artifactIndex === 0) return null
  return { root, parts: parts.slice(0, artifactIndex), artifact: parts[artifactIndex], glob }
}

function prefixContains(outer, inner) {
  return outer.root === inner.root && outer.parts.length <= inner.parts.length &&
    outer.parts.every((part, index) => part === inner.parts[index])
}

function targetMatchesPrefix(target, prefix) {
  return target.root === prefix.root && target.parts.length >= prefix.parts.length &&
    prefix.parts.every((part, index) => part === target.parts[index])
}

/** `find <构建产物目录> ... -delete` 的同类安全清理。 */
function parseArtifactFind(command) {
  const raw = String(command || '')
  if (!raw || raw.includes('`') || raw.includes('$(')) return null
  if (/\b(?:sudo|doas|xargs)\b/.test(raw)) return null
  const targets = []
  let sawFind = false
  for (const segment of splitShellSegments(raw)) {
    const tokens = shellTokens(segment)
    if (tokens[0] !== 'find') continue
    sawFind = true
    if (!tokens.includes('-delete')) return null
    if (tokens.some(token => token === '-exec' || token === '-execdir' || token === '-ok' || token === '-okdir')) return null
    const firstPath = tokens.slice(1).find(token => !token.startsWith('-'))
    if (!firstPath) return null
    const parsed = pathClassOf(firstPath)
    if (!parsed) return null
    targets.push(parsed)
  }
  return sawFind && targets.length > 0 ? targets : null
}

/** 严格解析 `rm` 的构建产物清理：拒绝 sudo/xargs/命令替换/通配符/..。 */
function parseArtifactRm(command) {
  const raw = String(command || '')
  if (!raw || raw.includes('`') || raw.includes('$(')) return null
  if (/\b(?:sudo|doas|xargs)\b/.test(raw)) return null
  const targets = []
  let sawRm = false
  for (const segment of splitShellSegments(raw)) {
    const tokens = shellTokens(segment)
    if (tokens[0] !== 'rm') continue
    sawRm = true
    let optionsEnded = false
    let count = 0
    for (let index = 1; index < tokens.length; index++) {
      const token = tokens[index]
      if (!optionsEnded && token === '--') {
        optionsEnded = true
        continue
      }
      if (!optionsEnded && token.startsWith('-') && token !== '-') continue
      count++
      const parsed = pathClassOf(token)
      if (!parsed) return null
      targets.push(parsed)
    }
    if (count === 0) return null
  }
  return sawRm && targets.length > 0 ? targets : null
}

function artifactSpecFor(command, risk, now, kind = 'artifact-rm', prefixOf = parseArtifactRm) {
  const targets = prefixOf(command)
  if (!targets) return null
  const prefixes = []
  for (const target of targets) {
    const prefix = { root: target.root, parts: target.parts }
    if (prefixes.some(existing => prefixContains(existing, prefix))) continue
    for (let index = prefixes.length - 1; index >= 0; index--) {
      if (prefixContains(prefix, prefixes[index])) prefixes.splice(index, 1)
    }
    prefixes.push(prefix)
  }
  const key = createHash('sha256').update(`${kind}:${JSON.stringify(prefixes)}`).digest('hex')
  return {
    kind,
    key,
    prefixes,
    level: risk.level || 'high',
    codes: kind === 'artifact-rm' ? ['destructive-rm', 'repo-delete'] : ['find-delete'],
    preview: String(command).replace(/\s+/g, ' ').slice(0, 300),
    createdAt: now,
  }
}

function hashCommand(command) {
  return createHash('sha256').update(normalizeCommand(command)).digest('hex')
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

/** 放行原因（规则标记）：压成单行、去首尾空白、限长；空或非字符串返回 null。 */
export function normalizeRuleReason(value) {
  if (typeof value !== 'string') return null
  const text = value.replace(/\s+/g, ' ').trim()
  if (!text) return null
  return text.length > MAX_RULE_REASON_LENGTH ? text.slice(0, MAX_RULE_REASON_LENGTH) : text
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
  const specs = []
  if (onlyLinkReasons) {
    // 与 filter/analyze 同源：只把真实 fetch 段里的主机写成 host 规则，
    // 否则 grep/heredoc 里的主机也会被落库，之后对该主机的真实访问永久免询问
    const hosts = unique(extractFetchUrls(raw).map(hostOf))
    for (const host of hosts) {
      specs.push({ kind: 'host', key: host, host, level, codes, preview, createdAt: now })
    }
  }
  if (codes.includes('destructive-rm')) {
    const artifactSpec = artifactSpecFor(raw, risk, now, 'artifact-rm', parseArtifactRm)
    if (artifactSpec) specs.push(artifactSpec)
  }
  if (codes.includes('find-delete')) {
    const findSpec = artifactSpecFor(raw, risk, now, 'artifact-find', parseArtifactFind)
    if (findSpec) specs.push(findSpec)
  }
  if (specs.length > 0 && reasons.every(reason =>
    HOST_REASON_CODES.has(reason.code) || reason.code === 'destructive-rm' ||
    reason.code === 'repo-delete' || reason.code === 'find-delete')) {
    return specs
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

/** 为一条待审批命令生成短期 token，客户端只回传 token，不直接提交命令正文。
 *
 * 传 `file` 时把待放行项短期落盘：插件重载会重建实例，内存态丢失会让用户点
 * 「始终允许」拿到 410；落盘后同一 token（或审批 callId）在 TTL 内仍可消费。
 * 文件 0600、目录 0700，最多 `maxEntries` 条，过期项在读写时清理。
 */
export class PendingRiskRules {
  constructor({ ttlMs = 10 * 60 * 1000, maxEntries = 100, now = Date.now, file, onError } = {}) {
    this.ttlMs = ttlMs
    this.maxEntries = maxEntries
    this.now = now
    this.file = file
    this.onError = onError
    this.entries = new Map()
    this.removed = new Set()
    this.loaded = false
    this.loading = undefined
    this.queue = Promise.resolve()
  }

  /** 读取落盘项并合并到内存；并发的 add 不会被覆盖。 */
  async load() {
    if (!this.file) {
      this.loaded = true
      return
    }
    if (!this.loading) {
      this.loading = (async () => {
        let dropped = 0
        try {
          const text = await readFile(this.file, 'utf8')
          const parsed = JSON.parse(text)
          const entries = Array.isArray(parsed?.entries) ? parsed.entries : []
          const now = this.now()
          for (const entry of entries) {
            if (!validPending(entry)) continue
            if (now - entry.at > this.ttlMs) {
              dropped += 1
              continue
            }
            if (this.removed.has(entry.token) || this.entries.has(entry.token)) continue
            this.entries.set(entry.token, entry)
          }
        } catch (error) {
          if (error?.code !== 'ENOENT') this.onError?.(error)
        }
        this.loaded = true
        this.cleanup()
        if (dropped > 0) await this.persist()
        this.removed.clear()
        return this.entries
      })()
    }
    return this.loading
  }

  add(command, risk, callId) {
    this.cleanup()
    const token = randomBytes(12).toString('hex')
    this.entries.set(token, {
      token,
      command: String(command || ''),
      risk,
      ...(callId === undefined ? {} : { callId: String(callId) }),
      at: this.now(),
    })
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      this.entries.delete(oldest)
      this.markRemoved(oldest)
    }
    this.changed()
    return token
  }

  take(token) {
    this.cleanup()
    const key = String(token || '')
    const entry = this.entries.get(key)
    if (!entry) return null
    this.entries.delete(key)
    this.markRemoved(key)
    this.changed()
    return entry
  }

  /** 兜底：审批 reason 里的 token 丢失时按 callId 取回同一待放行项。 */
  takeByCallId(callId) {
    this.cleanup()
    const key = String(callId || '')
    if (!key) return null
    for (const [token, entry] of this.entries) {
      if (entry.callId !== key) continue
      this.entries.delete(token)
      this.markRemoved(token)
      this.changed()
      return entry
    }
    return null
  }

  cleanup() {
    const now = this.now()
    for (const [key, entry] of this.entries) {
      if (now - entry.at > this.ttlMs) {
        this.entries.delete(key)
        this.markRemoved(key)
      }
    }
  }

  /** 落盘合并期间防止已消费/已淘汰的项被读回；合并结束后不必继续记录。 */
  markRemoved(token) {
    if (!this.loaded) this.removed.add(token)
  }

  changed() {
    if (!this.file) return
    void this.load().then(() => this.persist()).catch(error => this.onError?.(error))
  }

  persist() {
    if (!this.file) return Promise.resolve()
    const write = this.queue.then(async () => {
      this.cleanup()
      const text = JSON.stringify({ version: 1, entries: [...this.entries.values()] }, null, 2) + '\n'
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
      const temp = `${this.file}.${process.pid}.tmp`
      await writeFile(temp, text, { encoding: 'utf8', mode: 0o600 })
      await rename(temp, this.file)
    })
    this.queue = write.catch(() => {})
    return write
  }
}

function validPending(entry) {
  return entry && typeof entry === 'object' &&
    typeof entry.token === 'string' && entry.token.length >= 16 &&
    typeof entry.command === 'string' && Number.isFinite(entry.at) &&
    entry.risk && typeof entry.risk === 'object' &&
    (entry.callId === undefined || typeof entry.callId === 'string')
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
    ...(rule.kind === 'artifact-rm' || rule.kind === 'artifact-find' ? { scope: rule.kind } : {}),
    ...(typeof rule.reason === 'string' ? { reason: rule.reason } : {}),
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
          // 同一规则再次放行时用最新原因覆盖旧标记，便于复核。
          if (typeof spec.reason === 'string' && existing.reason !== spec.reason) existing.reason = spec.reason
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

  matchesArtifactRm(command) {
    const targets = parseArtifactRm(command)
    if (!targets) return null
    return this.rules.find(rule => rule.kind === 'artifact-rm' &&
      Array.isArray(rule.prefixes) &&
      targets.every(target => rule.prefixes.some(prefix => targetMatchesPrefix(target, prefix)))) || null
  }

  matchesArtifactFind(command) {
    const targets = parseArtifactFind(command)
    if (!targets) return null
    return this.rules.find(rule => rule.kind === 'artifact-find' &&
      Array.isArray(rule.prefixes) &&
      targets.every(target => rule.prefixes.some(prefix => targetMatchesPrefix(target, prefix)))) || null
  }

  allowedHosts() {
    return this.rules.filter(rule => rule.kind === 'host').map(rule => rule.host)
  }
}

function validRule(rule) {
  return rule && typeof rule === 'object' &&
    (rule.kind === 'command' || rule.kind === 'host' || rule.kind === 'artifact-rm' || rule.kind === 'artifact-find') &&
    typeof rule.key === 'string' && typeof rule.id === 'string' &&
    (rule.reason === undefined || typeof rule.reason === 'string') &&
    (rule.kind !== 'host' || (typeof rule.host === 'string' && rule.host.trim() !== '' && !/[\s/]/.test(rule.host))) &&
    (rule.kind !== 'artifact-rm' && rule.kind !== 'artifact-find' || Array.isArray(rule.prefixes))
}

function finishFilter(risk, reasons, allowedBy) {
  const level = reasons.some(reason => reason.level === 'high') ? 'high'
    : reasons.some(reason => reason.level === 'medium') ? 'medium' : 'none'
  return { ...risk, risk: reasons.length > 0, level, reasons, ...(allowedBy.length > 0 ? { allowedBy: allowedBy.join(',') } : {}) }
}

/** 按已保存规则过滤风险原因；只移除命令类/构建产物清理类或主机链接类原因。 */
export function filterRiskByRules(risk, command, store, allowHosts) {
  if (!risk?.risk) return risk
  if (store.matchesCommand(command)) {
    return { ...risk, risk: false, level: 'none', reasons: [], allowedBy: 'command' }
  }
  let reasons = risk.reasons
  const allowedBy = []
  if (store.matchesArtifactRm(command)) {
    const kept = reasons.filter(reason => reason.code !== 'destructive-rm' && reason.code !== 'repo-delete')
    if (kept.length !== reasons.length) {
      reasons = kept
      allowedBy.push('artifact-rm')
    }
  }
  if (store.matchesArtifactFind(command)) {
    const kept = reasons.filter(reason => reason.code !== 'find-delete')
    if (kept.length !== reasons.length) {
      reasons = kept
      allowedBy.push('artifact-find')
    }
  }
  if (reasons.length === 0) return finishFilter(risk, reasons, allowedBy)
  const ruleHosts = store.allowedHosts()
  if (ruleHosts.length === 0) return allowedBy.length > 0 ? finishFilter(risk, reasons, allowedBy) : risk
  // 与 analyzeCommand 同源：只看真正会被访问的链接（heredoc 正文、grep 模式串不算）。
  // 放行前必须能证明“每一条会执行的 fetch 都落在白名单里”：
  // 有看不到字面链接的 fetch 段（curl "$ENDPOINT"、xargs curl），
  // 或有主机段取不出来的 URL（动态展开 / 非法端口），都保持原判。
  if (hasOpaqueFetch(command)) return allowedBy.length > 0 ? finishFilter(risk, reasons, allowedBy) : risk
  const hosts = extractFetchUrls(command).map(hostOf)
  if (hosts.length === 0) return allowedBy.length > 0 ? finishFilter(risk, reasons, allowedBy) : risk
  if (hosts.some(host => !host)) return allowedBy.length > 0 ? finishFilter(risk, reasons, allowedBy) : risk
  const baseHosts = Array.isArray(allowHosts) && allowHosts.length > 0 ? allowHosts : DEFAULT_ALLOW_HOSTS
  const allHostsAllowed = hosts.every(host => isAllowedHost(host, baseHosts) || isAllowedHost(host, ruleHosts))
  if (!allHostsAllowed) return allowedBy.length > 0 ? finishFilter(risk, reasons, allowedBy) : risk
  const kept = reasons.filter(reason => !HOST_REASON_CODES.has(reason.code))
  if (kept.length !== reasons.length) {
    reasons = kept
    allowedBy.push('host')
  }
  return allowedBy.length > 0 ? finishFilter(risk, reasons, allowedBy) : risk
}
