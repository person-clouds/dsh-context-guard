/** 命令形态拦截：整文件 cat、无排除的家目录递归搜索、裸 curl API。
 * 默认返回 deny 并给出替代命令；可配置为 ask。DSH 不允许改写工具参数，
 * 因此这里只拒绝当前调用，由模型按提示重新发起有界调用。
 */

const SEGMENT_SPLIT_RE = /\s*(?:&&|\|\||;|\n)\s*/
const HOME_TARGET_RE = /^(?:~|\$HOME|\$\{HOME\})(?:\/.*)?$|^\/home\/[^/]+(?:\/.*)?$/
const CURL_RE = /(?:^|[;&|]\s*)curl\b([^;&|\n]*)/g

/** 未显式传入时的兜底工具名，与官方文件工具一致。 */
const DEFAULT_FILE_TOOLS = { read: 'read', grep: 'grep', glob: 'glob' }

function fileToolsOf(files) {
  const source = files || {}
  return {
    read: source.read || DEFAULT_FILE_TOOLS.read,
    grep: source.grep || DEFAULT_FILE_TOOLS.grep,
    glob: source.glob || DEFAULT_FILE_TOOLS.glob,
  }
}

/** 生成与当前文件工具有关的调用示例：ops_* 用 path/offset，官方 read 用 file_path/limit。 */
function readExample(name) {
  return name.startsWith('ops_')
    ? `${name}({ path: '<file>', offset: 1, limit: 120 })`
    : `${name}({ file_path: '<file>', limit: 120 })`
}


function segmentsOf(command) {
  return String(command || '').split(SEGMENT_SPLIT_RE).map(segment => segment.trim()).filter(Boolean)
}

function tokensOf(segment) {
  return segment.match(/"[^"]*"|'[^']*'|[^\s;&|()]+/g) || []
}

function normalizedToken(token) {
  return String(token || '').replace(/^['"]|['"]$/g, '').replace(/\/+$/g, '') || '/'
}

function hasExclusions(segment) {
  return /--glob(?:=|\s+)['"]?!/i.test(segment) ||
    /--exclude(?:-dir)?(?:=|\s+)/i.test(segment) ||
    /(?:^|\s)-g\s+['"]?!/i.test(segment)
}

function isHomeTarget(token) {
  return HOME_TARGET_RE.test(normalizedToken(token))
}

function lintWholeCat(command, files = {}) {
  const { read } = fileToolsOf(files)
  for (const segment of segmentsOf(command)) {
    const tokens = tokensOf(segment)
    const commandIndex = tokens.findIndex(token => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token))
    if (commandIndex < 0) continue
    const commandName = tokens[commandIndex].replace(/^['"]|['"]$/g, '')
    if (commandName !== 'cat') continue
    const args = tokens.slice(commandIndex + 1)
    if (args.length === 0 || args[0].startsWith('<')) continue
    if (/\|/.test(segment)) continue
    return {
      code: 'whole-file-cat',
      message: '整文件 cat 可能把大文件一次性放进上下文',
      alternative: `优先用 ${read} 工具：${readExample(read)}；或 sed -n '1,120p' <file>；按关键词：rg -n '关键词' <file>；确需全文：cat <file> 前加 # dsh-budget=6000`,
    }
  }
  return null
}

function lintRecursiveSearch(command, files = {}) {
  const { grep } = fileToolsOf(files)
  for (const segment of segmentsOf(command)) {
    const tokens = tokensOf(segment)
    const hasGrep = tokens.some(token => /(?:^|\/)grep$/.test(token))
    const hasRg = tokens.some(token => /(?:^|\/)rg$/.test(token))
    if (!hasGrep && !hasRg) continue
    if (hasGrep && !tokens.some(token => /^(?:-r|-R|--recursive)$/.test(token))) continue
    if (hasExclusions(segment)) continue
    const targets = tokens.filter(isHomeTarget)
    if (targets.length === 0) continue
    return {
      code: 'recursive-home-search',
      message: `在 ${targets[0]} 做无排除的递归搜索，容易扫到 node_modules/缓存并产生巨量输出`,
      alternative: `优先用 ${grep} 工具：${grep}({ pattern: '关键词', path: '${targets[0]}' })；或收窄范围并排除依赖：rg -n --glob '!**/node_modules/**' --glob '!**/.git/**' '关键词' ${targets[0]}`,
    }
  }
  return null
}

function lintBareCurlApi(command) {
  const text = String(command || '')
  CURL_RE.lastIndex = 0
  let match
  while ((match = CURL_RE.exec(text)) !== null) {
    const block = match[1] || ''
    if (!/\/api(?:\/|\b)/i.test(block)) continue
    if (/(?:^|\s)(?:-o|--output|--head|-I|--range|-r|--max-filesize)(?:\s|=|$)/.test(block)) continue
    const tail = text.slice(match.index + match[0].length)
    if (/^\s*\|\s*(?:jq|python|node|head|sed)\b/.test(tail)) continue
    return {
      code: 'bare-curl-api',
      message: '裸 curl API 可能把未裁剪的大响应直接放进上下文',
      alternative: '先裁剪字段或落盘：curl ... | jq \'{field1,field2}\'；或 curl -o /tmp/out.json ... 后再 jq 查询 /tmp/out.json',
    }
  }
  return null
}

/** 返回 `{ hit, reasons }`；同一命令只保留一条同类提示。files 传当前文件工具名（缺省用官方 read/grep/glob）。 */
export function lintCommand(command, files = {}) {
  const reasons = [
    lintWholeCat(command, files),
    lintRecursiveSearch(command, files),
    lintBareCurlApi(command),
  ].filter(Boolean)
  return { hit: reasons.length > 0, reasons }
}

/** 把命令 lint 转成 DSH `deny` 决策；reason 会作为模型可见的失败信息。 */
export function lintDenyDecision(lint, command = '') {
  const detailZh = lint.reasons.map(reason => `${reason.message}。改用：${reason.alternative}`).join('\n')
  const detailEn = lint.reasons.map(reason => reason.code).join(', ')
  const preview = String(command || '').replace(/\s+/g, ' ').slice(0, 300)
  return {
    kind: 'deny',
    reason: `context-guard command lint: ${detailEn}\n${detailZh}\n原始命令：${preview}\nDSH 不会自动改写命令，请改用上述有界形式后重新调用。`,
  }
}

/** 把命令 lint 转成 DSH `ask` 决策；多个提示合并。 */
export function lintAskDecision(lint, command = '') {
  const detailZh = lint.reasons.map(reason => `${reason.message}。替代：${reason.alternative}`).join('\n')
  const detailEn = lint.reasons.map(reason => reason.code).join(', ')
  const preview = String(command || '').replace(/\s+/g, ' ').slice(0, 300)
  return {
    kind: 'ask',
    reason: `context-guard command lint: ${detailEn}; command: ${preview}`,
    displayReason: {
      en: `This command may produce an oversized tool result (${detailEn}).\n${preview}\nConsider a bounded alternative before continuing.`,
      zh: `命令可能产生超大输出：\n${detailZh}\n命令：${preview}\n建议改用替代命令；确认仍要继续执行时请允许。`,
    },
  }
}

/** 按配置选择 deny（默认，硬拦截）或 ask（复杂流程可降级为确认）。 */
export function lintDecision(lint, command = '', mode = 'deny') {
  return mode === 'ask' ? lintAskDecision(lint, command) : lintDenyDecision(lint, command)
}
