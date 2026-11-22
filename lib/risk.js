/** Shell 风险命令识别：只做警示与确认，不改变命令参数，不替代 DSH 自身权限策略。 */

import { homedir } from 'node:os'
import { DEFAULT_ALLOWLIST } from './default-allowlist.js'

/** 内置链接白名单：来自随包 `config/risk-allow-default.json` 的全部分组。 */
export const DEFAULT_ALLOW_HOSTS = DEFAULT_ALLOWLIST.hosts

/** 会访问/打开链接的命令；只认段首命令，避免命中 Python 的 `open(` 或正文里的词。 */
const FETCH_COMMANDS = new Set(['curl', 'wget', 'xdg-open', 'sensible-browser', 'open', 'firefox', 'chromium', 'google-chrome'])
/** 命令前缀：跳过它们后才是真正执行的命令。 */
const COMMAND_PREFIXES = new Set([
  'sudo', 'doas', 'command', 'nohup', 'env', 'time', 'exec',
  'nice', 'ionice', 'stdbuf', 'setsid', 'busybox', 'unbuffer', 'watch',
])
const SHELL_COMMANDS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'])

function stripQuoted(command) {
  return String(command || '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
}

export function splitShellSegments(command) {
  const segments = []
  let current = ''
  let quote = ''
  for (let index = 0; index < command.length; index++) {
    const char = command[index]
    if (quote) {
      current += char
      if (char === '\\' && quote === '"' && index + 1 < command.length) {
        current += command[++index]
      } else if (char === quote) {
        quote = ''
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      current += char
      continue
    }
    if (char === '\\') {
      current += char
      if (index + 1 < command.length) current += command[++index]
      continue
    }
    if (char === ';' || char === '\n' || char === '|' || char === '&') {
      segments.push(current)
      current = ''
      if ((char === '|' || char === '&') && command[index + 1] === char) index++
      continue
    }
    current += char
  }
  segments.push(current)
  return segments.map(segment => segment.trim()).filter(Boolean)
}

export function shellTokens(segment) {
  const tokens = []
  let token = ''
  let quote = ''
  let hasToken = false
  for (let index = 0; index < segment.length; index++) {
    const char = segment[index]
    if (quote) {
      if (char === quote) {
        quote = ''
      } else if (char === '\\' && quote === '"' && index + 1 < segment.length) {
        token += segment[++index]
      } else {
        token += char
      }
      hasToken = true
      continue
    }
    if (/\s/.test(char)) {
      if (hasToken) {
        tokens.push(token)
        token = ''
        hasToken = false
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      hasToken = true
      continue
    }
    if (char === '\\' && index + 1 < segment.length) {
      token += segment[++index]
      hasToken = true
      continue
    }
    token += char
    hasToken = true
  }
  if (hasToken) tokens.push(token)
  return tokens
}

function isTemporaryPath(target) {
  const value = String(target || '').replace(/\/+$/, '')
  if (!value || value.split('/').includes('..')) return false
  if (value.includes('*') || value.includes('?') || value.includes('[')) return false
  return DEFAULT_ALLOWLIST.rm.tempRoots.some(root => value.startsWith(root + '/'))
}

function isTestPath(target) {
  const value = String(target || '').replace(/\/+$/, '')
  if (!value || value.split('/').includes('..')) return false
  if (value.includes('*') || value.includes('?') || value.includes('[')) return false
  return value.split('/').filter(Boolean).some(segment => {
    const name = segment.toLowerCase()
    return DEFAULT_ALLOWLIST.rm.testDirNames.includes(name) ||
      DEFAULT_ALLOWLIST.rm.testDirPatterns.some(pattern => pattern.test(name))
  })
}

function expandHomePath(target) {
  const value = String(target || '').replace(/\/+$/, '')
  if (!value) return ''
  const home = homedir().replace(/\/+$/, '')
  if (value === '~' || value === '$HOME' || value === '${HOME}') return home
  if (value.startsWith('~/')) return home + value.slice(1)
  if (value.startsWith('$HOME/')) return home + value.slice(5)
  if (value.startsWith('${HOME}/')) return home + value.slice(7)
  return value
}

/** 家目录 opt 只放行逐个列出的具体文件/目录；通配、`..`、目录本身都不放行。 */
function isHomeOptPath(target) {
  if (!DEFAULT_ALLOWLIST.rm.homeOpt) return false
  const value = expandHomePath(target)
  if (!value || value.split('/').includes('..')) return false
  if (value.includes('*') || value.includes('?') || value.includes('[')) return false
  const root = homedir().replace(/\/+$/, '') + '/opt'
  return value.startsWith(root + '/')
}

function isSafeRmPath(target) {
  return isTemporaryPath(target) || isTestPath(target) || isHomeOptPath(target)
}

/** 普通 rm 的目标全部在临时目录或 test 目录内才豁免；sudo/xargs/命令替换与任何其他目标都不豁免。 */
function safeRmOnly(command) {
  const raw = String(command || '')
  if (!raw || raw.includes('`') || raw.includes('$(')) return false
  if (/\b(?:sudo|doas|xargs)\b/.test(raw)) return false
  let sawRm = false
  for (const segment of splitShellSegments(raw)) {
    const tokens = shellTokens(segment)
    if (tokens[0] !== 'rm') continue
    sawRm = true
    let targets = 0
    let optionsEnded = false
    for (let index = 1; index < tokens.length; index++) {
      const token = tokens[index]
      if (!optionsEnded && token === '--') {
        optionsEnded = true
        continue
      }
      if (!optionsEnded && token.startsWith('-') && token !== '-') continue
      targets++
      if (!isSafeRmPath(token)) return false
    }
    if (targets === 0) return false
  }
  return sawRm
}

function isTempMktempTemplate(template) {
  const value = String(template || '').replace(/\/+$/, '')
  if (!value || value.split('/').includes('..')) return false
  if (value.includes('*') || value.includes('?') || value.includes('[')) return false
  if (!new RegExp(`X{${DEFAULT_ALLOWLIST.probes.mktempTemplateMinX},}`).test(value)) return false
  return DEFAULT_ALLOWLIST.probes.mktempRoots.some(root => value.startsWith(root + '/'))
}

/** 识别 `f=$(mktemp /tmp/...) && ... rm -f "$f"` 这类临时文件写探测。 */
function isMktempThenRmProbe(command) {
  if (!DEFAULT_ALLOWLIST.probes.mktempThenRm) return false
  const raw = String(command || '')
  if (!raw || raw.includes('`')) return false
  const assignments = [...raw.matchAll(/(?:^|[;&|]\s*)([A-Za-z_][A-Za-z0-9_]*)=\$\(\s*mktemp\b([^)]*)\)/g)]
  if (assignments.length !== 1) return false
  if ((raw.match(/\$\(/g) || []).length !== 1) return false
  const variable = assignments[0][1]
  const templateMatch = assignments[0][2].trim().match(/^(?:"([^"]*)"|'([^']*)'|(\S+))/)
  const template = templateMatch ? (templateMatch[1] ?? templateMatch[2] ?? templateMatch[3] ?? '') : ''
  if (!isTempMktempTemplate(template)) return false
  const assignRe = new RegExp(`\\b${variable}\\s*=`, 'g')
  if ((raw.match(assignRe) || []).length !== 1) return false
  let sawRm = false
  for (const segment of splitShellSegments(raw)) {
    const tokens = shellTokens(segment)
    if (tokens[0] !== 'rm') continue
    sawRm = true
    const targets = []
    let optionsEnded = false
    for (let index = 1; index < tokens.length; index++) {
      const token = tokens[index]
      if (!optionsEnded && token === '--') {
        optionsEnded = true
        continue
      }
      if (!optionsEnded && token.startsWith('-') && token !== '-') continue
      targets.push(token)
    }
    if (targets.length !== 1) return false
    if (targets[0] !== `$${variable}` && targets[0] !== `\${${variable}}`) return false
  }
  return sawRm
}

/** 写权限探测文件名，例如 .dsh-write-test、write-test-123。 */
function isWriteTestTarget(target) {
  const value = String(target || '').replace(/\/+$/, '')
  if (!value || value.split('/').includes('..')) return false
  if (value.includes('*') || value.includes('?') || value.includes('[')) return false
  const base = value.split('/').filter(Boolean).pop() || ''
  return DEFAULT_ALLOWLIST.probes.writeTestFilePattern.test(base)
}

/** 识别 `touch <write-test 文件> && rm <同一文件>` 这类自清理写权限探测。 */
function isTouchThenRmProbe(command) {
  if (!DEFAULT_ALLOWLIST.probes.touchThenRm) return false
  const raw = String(command || '')
  if (!raw || raw.includes('`') || raw.includes('$(')) return false
  const segments = splitShellSegments(raw)
  if (segments.length !== 2) return false
  const touchTokens = shellTokens(segments[0])
  const rmTokens = shellTokens(segments[1])
  if (touchTokens[0] !== 'touch' || rmTokens[0] !== 'rm') return false
  const touchTargets = touchTokens.slice(1).filter(token => !token.startsWith('-'))
  const rmTargets = rmTokens.slice(1).filter(token => !token.startsWith('-'))
  if (touchTargets.length !== 1 || rmTargets.length !== 1) return false
  const touchTarget = touchTargets[0].replace(/\/+$/, '')
  const rmTarget = rmTargets[0].replace(/\/+$/, '')
  return touchTarget === rmTarget && isWriteTestTarget(touchTarget)
}

/** `sudo -n true` 一类的无副作用探测不触发提权风险；只有探测段也放行。 */
function isSudoProbe(segment) {
  const tokens = shellTokens(segment)
  if (tokens[0] !== 'sudo') return false
  let nonInteractive = false
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index]
    if (token === '-n' || token === '--non-interactive') {
      nonInteractive = true
      continue
    }
    if (token === '--') continue
    return nonInteractive && index === tokens.length - 1 &&
      (token === 'true' || token === '-v' || token === '--validate')
  }
  return false
}

const SUDO_READONLY_COMMANDS = DEFAULT_ALLOWLIST.commands.sudoReadOnly

const SYSTEMCTL_READONLY_SUBCOMMANDS = DEFAULT_ALLOWLIST.commands.systemctlReadOnly

/** `sudo -n <只读命令>` 仅做状态检查，不触发提权风险；写操作仍拦截。 */
function isSudoReadOnly(segment) {
  const tokens = shellTokens(segment)
  if (tokens[0] !== 'sudo') return false
  let index = 1
  let nonInteractive = false
  while (index < tokens.length) {
    const token = tokens[index]
    if (token === '-n' || token === '--non-interactive') {
      nonInteractive = true
      index++
      continue
    }
    if (token === '--') {
      index++
      break
    }
    if (token.startsWith('-')) return false
    break
  }
  if (!nonInteractive || index >= tokens.length) return false
  const command = tokens[index].split('/').pop()
  if (!SUDO_READONLY_COMMANDS.has(command)) return false
  if (command === 'journalctl') {
    return !tokens.slice(index + 1).some(token => /^--(?:vacuum|rotate|flush)/.test(token))
  }
  if (command === 'systemctl') {
    return SYSTEMCTL_READONLY_SUBCOMMANDS.has(tokens[index + 1])
  }
  return true
}

function hasPrivilegeEscalation(raw) {
  const text = stripQuoted(raw)
  if (/(?:^|[;&|]\s*)su\s+-/.test(text)) return true
  for (const segment of splitShellSegments(raw)) {
    const tokens = shellTokens(segment)
    if (tokens[0] === 'doas') return true
    if (tokens[0] === 'sudo' && !isSudoProbe(segment) && !isSudoReadOnly(segment)) return true
  }
  return false
}

function patternRules() {
  return [
    {
      code: 'destructive-rm',
      level: 'high',
      test: (text, raw) => (/(?:^|[;&|()\n]\s*)(?:(?:sudo|doas)\s+)?rm\s+/.test(text) ||
        /\bxargs\b[^\n]*\brm\b/.test(text)) && !safeRmOnly(raw) && !isTouchThenRmProbe(raw) && !isMktempThenRmProbe(raw),
      message: '包含删除文件/目录命令（rm）',
    },
    {
      code: 'repo-delete',
      level: 'high',
      test: text => /\brm\s+[^\n]*\/?\.git(?:\s|$|\/)/.test(text) || /\brm\s+[^\n]*\*/.test(text),
      message: '可能删除仓库元数据或批量文件',
    },
    {
      code: 'find-delete',
      level: 'high',
      test: text => /\bfind\b[^\n]*\s-delete\b/.test(text),
      message: 'find -delete 会批量删除匹配文件',
    },
    {
      code: 'disk-destructive',
      level: 'high',
      test: text => /\b(?:dd|mkfs(?:\.\w+)?|wipefs|fdisk|parted|shred)\b/.test(text) ||
        /\btruncate\s+-s\s*0\b/.test(text) ||
        />\s*\/dev\/sd[a-z]/.test(text),
      message: '包含磁盘/分区/不可恢复删除操作',
    },
    {
      code: 'git-destructive',
      level: 'high',
      test: text => /\bgit\s+reset\s+--hard\b/.test(text) ||
        /\bgit\s+clean\s+-[A-Za-z]*[fdx]/.test(text) ||
        /\bgit\s+push\b[^\n]*(?:--force\b|--force-with-lease\b|\s-f(?:\s|$))/.test(text) ||
        /\bgit\s+(?:branch\s+-D|tag\s+-d|remote\s+remove)\b/.test(text) ||
        /\bgit\s+checkout\s+--\s+\./.test(text) ||
        /\bgit\s+(?:reflog\s+expire|gc\s+--prune)\b/.test(text),
      message: '包含丢弃改动、强推、删分支或清理 git 历史的命令',
    },
    {
      code: 'system-power',
      level: 'high',
      test: text => /(?:^|[;&|]\s*)(?:reboot|shutdown|poweroff|halt|init\s+0)\b/.test(text) ||
        /(?:^|[;&|]\s*)(?:sudo\s+)?(?:systemctl|service)\s+(?:stop|disable|mask)\b/.test(text) ||
        /\bcrontab\s+-r\b/.test(text),
      message: '会停止服务、关机或删除定时任务',
    },
    {
      code: 'kill-broad',
      level: 'high',
      test: text => /\bkill\s+-9\s+-1\b/.test(text) || /\bpkill\s+-9\b/.test(text) || /\bkillall\b/.test(text),
      message: '大范围杀进程可能造成服务中断',
    },
    {
      code: 'firewall-flush',
      level: 'high',
      test: text => /\biptables\s+-F\b/.test(text) || /\bufw\s+disable\b/.test(text) || /\bnft\s+flush\b/.test(text),
      message: '清空或关闭防火墙',
    },
    {
      code: 'container-delete',
      level: 'high',
      test: text => /\bdocker\s+(?:system\s+prune|volume\s+rm|container\s+prune|image\s+prune|rm\s+-f|rmi\s+-f)\b/.test(text) ||
        /\bkubectl\s+delete\b/.test(text) || /\bhelm\s+uninstall\b/.test(text),
      message: '删除容器、镜像、数据卷或 K8s 资源',
    },
    {
      code: 'database-destructive',
      level: 'high',
      test: text => /\b(?:drop\s+(?:database|table)|truncate\s+table)\b/i.test(text) ||
        /\bdelete\s+from\b(?![^\n]*\bwhere\b)/i.test(text),
      message: '不可恢复的数据库删除/清空操作',
    },
    {
      code: 'download-execute',
      level: 'high',
      test: text => /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba)?sh\b/.test(text) ||
        /\b(?:ba)?sh\s+<\(\s*(?:curl|wget)\b/.test(text) ||
        /\b(?:ba)?sh\s+-c\s+["']?\$\(\s*(?:curl|wget)\b/.test(text),
      message: '从网络下载内容并直接执行，极可能是恶意脚本',
    },
    {
      code: 'privilege-escalation',
      level: 'medium',
      test: (text, raw) => hasPrivilegeEscalation(raw),
      message: '使用提权命令（sudo/doas/su）',
    },
    {
      code: 'shell-history',
      level: 'medium',
      test: text => /\bhistory\s+-c\b/.test(text) || /\brm\s+[^\n]*\.bash_history\b/.test(text),
      message: '清理 shell 历史记录',
    },
  ]
}

export function extractUrls(command) {
  // 反引号算 URL 的一部分：`http://`host`/x` 是运行期才展开的动态地址，截断会丢掉整段
  return String(command || '').match(/https?:\/\/[^\s"'<>|]+/gi) || []
}

export function hostOf(raw) {
  try {
    return new URL(raw).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export function isAllowedHost(host, allowHosts) {
  if (!host) return false
  return allowHosts.some(item => {
    const normalized = String(item).toLowerCase()
    return host === normalized || host.endsWith('.' + normalized)
  })
}

/** 前缀命令中带参数的选项：跳过它们时连参数一起跳过，避免把参数当成命令名。 */
const PREFIX_VALUE_FLAGS = {
  sudo: new Set(['-u', '-g', '-p', '-C', '-D', '-h', '-r', '-t', '-U', '-T']),
  env: new Set(['-u', '-S', '-C']),
  timeout: new Set(['-s', '-k']),
  xargs: new Set(['-I', '-n', '-P', '-d', '-E', '-s', '-L', '-a']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '-n', '-p', '-t']),
  stdbuf: new Set(['-i', '-o', '-e']),
  watch: new Set(['-n', '--interval']),
}
/** 段首可能是 shell 关键字而不是命令。 */
const SHELL_KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', 'in', 'fi', 'done', 'esac'])

/** 去路径、去子 shell 符号、统一小写，得到可比较的命令名。 */
function bareCommand(token) {
  return String(token || '')
    .replace(/^[({$!]+/, '')
    .replace(/[)};]+$/, '')
    .replace(/\.exe$/i, '')
    .split('/').pop()
    .toLowerCase()
}

/** 跳过前缀命令的选项与 `--`，返回其后第一个参数位置。 */
function skipPrefixArgs(tokens, start, prefix) {
  const valueFlags = PREFIX_VALUE_FLAGS[prefix]
  let index = start
  while (index < tokens.length) {
    const token = tokens[index]
    if (token === '--') return index + 1
    if (!token.startsWith('-')) return index
    if (valueFlags && !token.includes('=') && valueFlags.has(token)) {
      index += 2
      continue
    }
    index += 1
  }
  return index
}

/** 取一段 shell 里真正执行命令的首词；跳过赋值、关键字与 sudo/env/timeout/xargs 等前缀。 */
function commandHead(tokens) {
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1
      continue
    }
    const name = bareCommand(token)
    if (!name) {
      index += 1
      continue
    }
    if (SHELL_KEYWORDS.has(name)) {
      index += 1
      continue
    }
    if (COMMAND_PREFIXES.has(name)) {
      index = skipPrefixArgs(tokens, index + 1, name)
      continue
    }
    if (name === 'timeout') {
      let next = skipPrefixArgs(tokens, index + 1, name)
      if (next < tokens.length) next += 1 // 时长参数
      index = next
      continue
    }
    if (name === 'xargs') {
      index = skipPrefixArgs(tokens, index + 1, name)
      continue
    }
    return name
  }
  return ''
}

/** 扫一行：找出 heredoc 起点（跳过引号内的 `<<` 与 `#` 注释），并返回行末的引号状态。 */
function scanHeredocLine(line, quote) {
  let state = quote
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (state) {
      if (state === '"' && char === '\\') {
        index += 1
        continue
      }
      if (char === state) state = ''
      continue
    }
    if (char === '\\') {
      index += 1
      continue
    }
    if (char === "'" || char === '"') {
      state = char
      continue
    }
    if (char === '#' && (index === 0 || /\s/.test(line[index - 1]))) return { quote: state, terminator: '' }
    if (char !== '<' || line[index + 1] !== '<' || line[index + 2] === '<') continue
    const match = /^<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(line.slice(index))
    if (match) return { quote: state, terminator: match[3], dash: match[1] === '-', at: index }
    index += 1
  }
  return { quote: state, terminator: '' }
}

/** heredoc 正文会被 shell 当脚本执行吗：`bash <<EOF`、`sh -s <<EOF`、`cat <<EOF | bash`。 */
function heredocExecutesShell(line, at) {
  if (!Number.isInteger(at)) return false
  const before = line.slice(0, at)
  const head = commandHead(shellTokens(before.replace(/^[\s\S]*[;|&(]/, '')))
  if (SHELL_COMMANDS.has(head)) return true
  return /\|\s*(?:sudo\s+)?(?:[\w.-]+\/)*(?:ba|z|k|fi)?sh\b/.test(line)
}

/** 去掉 heredoc 正文：`<<EOF … EOF` 之间的内容按文本处理，不当命令。
 *
 * 例外：正文会喂给 shell 执行（`bash <<EOF`、`… <<EOF | bash`）时保留，
 * 否则会把 `bash <<EOF … curl … EOF` 这类真实执行当成文档内容漏掉。
 */
function stripHeredocBodies(command) {
  const kept = []
  let heredoc = null
  let quote = ''
  for (const line of String(command || '').split('\n')) {
    if (heredoc) {
      // 与 bash 一致：普通 heredoc 终止符必须整行相等；`<<-` 允许前导 tab
      const candidate = heredoc.dash ? line.replace(/^\t+/, '') : line.replace(/\r$/, '')
      if (candidate === heredoc.terminator) heredoc = null
      continue
    }
    const scan = scanHeredocLine(line, quote)
    quote = scan.quote
    kept.push(line)
    if (!scan.terminator) continue
    if (heredocExecutesShell(line, scan.at)) continue
    heredoc = { terminator: scan.terminator, dash: scan.dash }
  }
  return kept.join('\n')
}

/** 取 `bash -c` / `bash -lc` 这类内联脚本参数；没有则返回空串。 */
function inlineScript(tokens) {
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index]
    if (token === '--') return ''
    if (!token.startsWith('-') || token.startsWith('--')) continue
    if (token.slice(1).includes('c') && index + 1 < tokens.length) return tokens[index + 1]
  }
  return ''
}

/** 取 `$(...)` 与反引号里的命令文本：命令替换里的 fetch 也会真正执行（单引号内不算，注释里不算）。 */
function commandSubstitutions(command) {
  const found = []
  const text = String(command || '')
  let quote = ''
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quote === "'") {
      if (char === "'") quote = ''
      continue
    }
    if (quote === '"') {
      if (char === '\\') {
        index += 1
        continue
      }
      if (char === '"') quote = ''
      // 双引号内的命令替换仍会执行，继续往下抽
    } else {
      if (char === '\\') {
        index += 1
        continue
      }
      if (char === "'" || char === '"') {
        quote = char
        continue
      }
      if (char === '#' && (index === 0 || /\s/.test(text[index - 1]))) {
        const newline = text.indexOf('\n', index)
        if (newline < 0) break
        index = newline
        continue
      }
    }
    if (char === '`') {
      const end = text.indexOf('`', index + 1)
      if (end > index) {
        found.push(text.slice(index + 1, end))
        index = end
      }
      continue
    }
    if (char !== '$' || text[index + 1] !== '(') continue
    let depth = 0
    let end = index + 1
    for (; end < text.length; end++) {
      if (text[end] === '(') depth += 1
      else if (text[end] === ')') {
        depth -= 1
        if (depth === 0) break
      }
    }
    if (depth === 0 && end < text.length) {
      found.push(text.slice(index + 2, end))
      index = end
    }
  }
  return found
}

/** 收集 fetch 段：每段给出该段里的字面链接；没有字面链接的 fetch 段也记录（urls 为空）。 */
function fetchSites(command) {
  const cleaned = stripHeredocBodies(command)
  const sites = []
  for (const inner of commandSubstitutions(cleaned)) sites.push(...fetchSites(inner))
  for (const segment of splitShellSegments(cleaned)) {
    const tokens = shellTokens(segment)
    // env -S 'curl …'：参数本身就是一整条命令（commandHead 会把它当成普通参数跳过，先处理）
    if (bareCommand(tokens[0]) === 'env') {
      const flagIndex = tokens.indexOf('-S')
      if (flagIndex >= 0 && tokens[flagIndex + 1]) {
        sites.push(...fetchSites(tokens[flagIndex + 1]))
        continue
      }
    }
    const head = commandHead(tokens)
    if (!head) continue
    if (SHELL_COMMANDS.has(head)) {
      const script = inlineScript(tokens)
      if (script) sites.push(...fetchSites(script))
      continue
    }
    // eval …：参数会被当成命令重新执行
    if (head === 'eval') {
      const payload = tokens.slice(1).join(' ')
      if (payload) sites.push(...fetchSites(payload))
      continue
    }
    // find … -exec/-execdir/-ok 之后的命令同样会执行
    if (head === 'find') {
      const execIndex = tokens.findIndex(token => ['-exec', '-execdir', '-ok', '-okdir'].includes(token))
      if (execIndex > 0) sites.push(...fetchSites(tokens.slice(execIndex + 1).join(' ')))
      continue
    }
    // ssh/chroot：跳过主机或新根目录后，后面还是命令
    if (head === 'ssh' || head === 'chroot') {
      const offset = head === 'ssh' ? tokens.slice(1).findIndex(token => !token.startsWith('-')) + 2 : 2
      if (offset >= 2 && offset < tokens.length) sites.push(...fetchSites(tokens.slice(offset).join(' ')))
      continue
    }
    if (FETCH_COMMANDS.has(head)) sites.push({ urls: extractUrls(segment) })
  }
  return sites
}

/**
 * 只取命令里真正会被访问/打开的链接：按 shell 段判断段首命令，
 * heredoc 正文、引号内模式串、文档文本不参与。
 */
export function extractFetchUrls(command) {
  return fetchSites(command).flatMap(site => site.urls)
}

/** 是否存在看不到字面链接的 fetch 段（`curl "$ENDPOINT"`、`wget -i urls.txt`）。 */
export function hasOpaqueFetch(command) {
  return fetchSites(command).some(site => site.urls.length === 0)
}


/** 规范化空白与首尾空白，用于生成稳定、窄范围的风险放行规则。 */
export function normalizeCommand(command) {
  return String(command || '').replace(/\s+/g, ' ').trim()
}

/** 分析一条 shell 命令；不执行、不修改命令。 */
export function analyzeCommand(command, options = {}) {
  const raw = String(command || '')
  const text = stripQuoted(raw)
  const reasons = []
  const add = (code, level, message) => {
    if (!reasons.some(reason => reason.code === code)) reasons.push({ code, level, message })
  }

  for (const rule of patternRules()) {
    if (rule.test(text, raw)) add(rule.code, rule.level, rule.message)
  }

  const urls = extractFetchUrls(raw)
  if (urls.length > 0) {
    const allowHosts = Array.isArray(options.allowHosts) && options.allowHosts.length > 0
      ? options.allowHosts
      : DEFAULT_ALLOW_HOSTS
    const unknown = urls.filter(url => !isAllowedHost(hostOf(url), allowHosts))
    if (unknown.length > 0) {
      add('unknown-link', 'medium', `访问/打开未在白名单中的链接：${unknown[0].slice(0, 120)}`)
    }
    const insecure = urls.filter(url => url.toLowerCase().startsWith('http://') && !isAllowedHost(hostOf(url), allowHosts))
    if (insecure.length > 0) {
      add('insecure-http', 'medium', `使用明文 HTTP 链接：${insecure[0].slice(0, 120)}`)
    }
  }

  const level = reasons.some(reason => reason.level === 'high') ? 'high'
    : reasons.some(reason => reason.level === 'medium') ? 'medium' : 'none'
  return { risk: reasons.length > 0, level, reasons, preview: raw.replace(/\s+/g, ' ').slice(0, 300) }
}

/** 生成 DSH `ask` 决策；用户确认后才允许执行。 */
export function riskAskDecision(risk) {
  const detailZh = risk.reasons.map(reason => reason.message).join('；')
  const detailEn = risk.reasons.map(reason => reason.code).join(', ')
  const command = risk.preview ? `命令：${risk.preview}` : ''
  return {
    kind: 'ask',
    reason: `context-guard risk check (${risk.level}): ${detailEn}; command: ${risk.preview}`,
    displayReason: {
      en: `This command matched a safety rule (${risk.level}): ${detailEn}.\n${risk.preview}\nConfirm only if you understand the impact.`,
      zh: `风险命令需要确认（${risk.level}）：${detailZh}。\n${command}\n确认理解影响后再允许执行。`,
    },
  }
}
