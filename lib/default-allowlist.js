/** 内置风险放行默认值：读取随包发布的 `config/risk-allow-default.json`。
 *
 * 文件缺失或字段非法时回退「最小安全默认」并告警：只保留 loopback 链接与标准临时目录，
 * 其余放行能力关闭。回退方向是更严格（更多命令需要确认），不会放大权限。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** 随包发布的默认配置文件绝对路径。 */
export const DEFAULT_ALLOWLIST_FILE = join(here, '..', 'config', 'risk-allow-default.json')

/** 主机分组顺序；分组用于文档与审阅，运行时不区分来源。 */
export const HOST_GROUPS = ['local', 'codeHosting', 'api', 'docs', 'techMedia']

const TEMP_ROOTS = ['/tmp', '/var/tmp', '$TMPDIR', '${TMPDIR}']

/** 最小安全默认：配置文件不可用时的兜底，只会更严格。 */
export const FALLBACK_CONFIG = {
  version: 1,
  hosts: {
    local: ['localhost', '127.0.0.1', '[::1]'],
    codeHosting: [],
    api: [],
    docs: [],
    techMedia: [],
  },
  rm: {
    tempRoots: [...TEMP_ROOTS],
    homeOpt: false,
    testDirNames: [],
    testDirPatterns: [],
    artifactDirs: [],
  },
  probes: {
    mktempRoots: [...TEMP_ROOTS],
    mktempTemplateMinX: 3,
    writeTestFilePattern: '(?:^|[._-])(?:dsh[._-]?)?write[._-]?test(?:$|[._-])',
    touchThenRm: true,
    mktempThenRm: true,
  },
  commands: {
    sudoReadOnly: [],
    systemctlReadOnly: [],
  },
  git: {
    readOnlySubcommands: [],
  },
}

function invalid(message) {
  throw new Error(message)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringArray(value, field) {
  if (!Array.isArray(value)) invalid(`${field} 必须是数组`)
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.length === 0) invalid(`${field}[${index}] 必须是非空字符串`)
    if (/\s/.test(item)) invalid(`${field}[${index}] 不能包含空白`)
    return item
  })
}

function booleanValue(value, field) {
  if (typeof value !== 'boolean') invalid(`${field} 必须是布尔值`)
  return value
}

function positiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) invalid(`${field} 必须是正整数`)
  return value
}

function regexList(value, field) {
  return stringArray(value, field).map((item, index) => {
    try {
      return new RegExp(item)
    } catch {
      return invalid(`${field}[${index}] 不是合法正则：${item}`)
    }
  })
}

function compileRegex(value, field, flags = '') {
  if (typeof value !== 'string' || value.length === 0) invalid(`${field} 必须是非空字符串`)
  try {
    return new RegExp(value, flags)
  } catch {
    return invalid(`${field} 不是合法正则：${value}`)
  }
}

function hostGroupsOf(hosts) {
  if (!isPlainObject(hosts)) invalid('hosts 必须是对象')
  for (const key of Object.keys(hosts)) {
    if (!HOST_GROUPS.includes(key)) invalid(`hosts 含未知分组：${key}`)
  }
  const groups = {}
  for (const group of HOST_GROUPS) {
    if (!(group in hosts)) invalid(`hosts 缺少分组：${group}`)
    const items = stringArray(hosts[group], `hosts.${group}`)
    for (const host of items) {
      if (host.includes('*') || host.includes('/') || host.includes(' ')) {
        invalid(`hosts.${group} 含非法主机：${host}`)
      }
    }
    groups[group] = items.map(host => host.toLowerCase())
  }
  const flattened = [...new Set(HOST_GROUPS.flatMap(group => groups[group]))]
  if (flattened.length === 0) invalid('hosts 不能为空')
  return { groups, flattened }
}

/** 把原始配置规范化成运行时结构；任何字段非法都抛错，由调用方回退。 */
function normalizeConfig(raw) {
  if (!isPlainObject(raw)) invalid('配置根节点必须是对象')
  if (raw.version !== 1) invalid(`不支持的配置版本：${raw.version}`)
  const { groups, flattened } = hostGroupsOf(raw.hosts)

  const rm = raw.rm
  if (!isPlainObject(rm)) invalid('rm 必须是对象')
  const testDirNames = stringArray(rm.testDirNames, 'rm.testDirNames').map(name => name.toLowerCase())
  const artifactDirs = stringArray(rm.artifactDirs, 'rm.artifactDirs')
  for (const name of artifactDirs) {
    if (name.includes('/')) invalid(`rm.artifactDirs 只能写路径段：${name}`)
  }

  const probes = raw.probes
  if (!isPlainObject(probes)) invalid('probes 必须是对象')

  const commands = raw.commands
  if (!isPlainObject(commands)) invalid('commands 必须是对象')

  const git = raw.git
  if (!isPlainObject(git)) invalid('git 必须是对象')

  return {
    hostGroups: groups,
    hosts: flattened,
    rm: {
      tempRoots: stringArray(rm.tempRoots, 'rm.tempRoots'),
      homeOpt: booleanValue(rm.homeOpt, 'rm.homeOpt'),
      testDirNames,
      testDirPatterns: regexList(rm.testDirPatterns, 'rm.testDirPatterns'),
      artifactDirs: new Set(artifactDirs),
    },
    probes: {
      mktempRoots: stringArray(probes.mktempRoots, 'probes.mktempRoots'),
      mktempTemplateMinX: positiveInteger(probes.mktempTemplateMinX, 'probes.mktempTemplateMinX'),
      writeTestFilePattern: compileRegex(probes.writeTestFilePattern, 'probes.writeTestFilePattern', 'i'),
      touchThenRm: booleanValue(probes.touchThenRm, 'probes.touchThenRm'),
      mktempThenRm: booleanValue(probes.mktempThenRm, 'probes.mktempThenRm'),
    },
    commands: {
      sudoReadOnly: new Set(stringArray(commands.sudoReadOnly, 'commands.sudoReadOnly')),
      systemctlReadOnly: new Set(stringArray(commands.systemctlReadOnly, 'commands.systemctlReadOnly')),
    },
    git: {
      readOnlySubcommands: stringArray(git.readOnlySubcommands, 'git.readOnlySubcommands'),
    },
  }
}

/**
 * 读取并校验默认配置。
 * - `file`：配置文件路径，默认随包文件；
 * - `warn`：回退告警回调，默认 `console.warn`；
 * - 返回 `{ ...normalizeConfig(), file, usedFallback }`。
 */
export function loadDefaultAllowlist({ file = DEFAULT_ALLOWLIST_FILE, warn = message => console.warn(message) } = {}) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return { ...normalizeConfig(raw), file, usedFallback: false }
  } catch (error) {
    warn(`[dsh-context-guard] 默认放行配置不可用（${file}）：${error?.message || error}；已回退最小安全默认。`)
    return { ...normalizeConfig(FALLBACK_CONFIG), file, usedFallback: true }
  }
}

/** 进程内共享的规范化默认值。 */
export const DEFAULT_ALLOWLIST = loadDefaultAllowlist()
