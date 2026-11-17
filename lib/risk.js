/** Shell 风险命令识别：只做警示与确认，不改变命令参数，不替代 DSH 自身权限策略。 */

const DEFAULT_ALLOW_HOSTS = [
  'localhost',
  '127.0.0.1',
  '[::1]',
  'github.com',
  'gitee.com',
  'raw.githubusercontent.com',
]

const FETCH_OR_OPEN_RE = /\b(?:curl|wget|xdg-open|sensible-browser|open|firefox|chromium|google-chrome)\b/

function stripQuoted(command) {
  return String(command || '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
}

function splitShellSegments(command) {
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

function shellTokens(segment) {
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
  return ['/tmp', '/var/tmp', '$TMPDIR', '${TMPDIR}'].some(root => value.startsWith(root + '/'))
}

/** 普通 rm 的目标全部在临时目录内才豁免；sudo/xargs/命令替换与任何非临时目标都不豁免。 */
function temporaryRmOnly(command) {
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
      if (!isTemporaryPath(token)) return false
    }
    if (targets === 0) return false
  }
  return sawRm
}

function patternRules() {
  return [
    {
      code: 'destructive-rm',
      level: 'high',
      test: (text, raw) => (/(?:^|[;&|()\n]\s*)(?:(?:sudo|doas)\s+)?rm\s+/.test(text) ||
        /\bxargs\b[^\n]*\brm\b/.test(text)) && !temporaryRmOnly(raw),
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
      test: text => /(?:^|[;&|]\s*)(?:sudo|doas)\b/.test(text) || /(?:^|[;&|]\s*)su\s+-/.test(text),
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

function extractUrls(command) {
  return String(command || '').match(/https?:\/\/[^\s"'`<>|]+/gi) || []
}

function hostOf(raw) {
  try {
    return new URL(raw).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function isAllowedHost(host, allowHosts) {
  if (!host) return false
  return allowHosts.some(item => {
    const normalized = String(item).toLowerCase()
    return host === normalized || host.endsWith('.' + normalized)
  })
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

  const urls = extractUrls(raw)
  if (urls.length > 0 && FETCH_OR_OPEN_RE.test(text)) {
    const allowHosts = Array.isArray(options.allowHosts) && options.allowHosts.length > 0
      ? options.allowHosts
      : DEFAULT_ALLOW_HOSTS
    const unknown = urls.filter(url => !isAllowedHost(hostOf(url), allowHosts))
    if (unknown.length > 0) {
      add('unknown-link', 'medium', `访问/打开未在白名单中的链接：${unknown[0].slice(0, 120)}`)
    }
    const insecure = urls.filter(url => url.startsWith('http://') && !isAllowedHost(hostOf(url), allowHosts))
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
