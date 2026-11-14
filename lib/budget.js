/** 工具输出预算：命令分类、预算选择与有界摘要渲染。 */
import { clamp } from './common.js'

export const DEFAULT_THRESHOLD = 3000
export const DEFAULT_HARD_MAX = 12000
export const DEFAULT_HEAD = 1200
export const DEFAULT_TAIL = 800
export const DEFAULT_ERROR_BUDGET = 4000

export const DEFAULT_CATEGORY_BUDGETS = {
  default: 3000,
  status: 2500,
  logs: 4000,
  source: 5000,
  diff: 6000,
  build: 8000,
  unbounded: 2500,
}

const UNBOUNDED_PATTERNS = [
  /(^|[;&|]\s*)cat\b/,
  /(^|[;&|]\s*)less\b/,
  /(^|[;&|]\s*)more\b/,
  /\bfind\s+\/(?:\s|$)/,
  /\bdu\s+(?:-[A-Za-z]+\s+)*\/(?:\s|$)/,
  /\bls\s+[^;&|]*-R\b/,
]

const BUILD_RE = /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|build|lint|typecheck)\b|\bgo\s+test\b|\bcargo\s+test\b|\bpytest\b|\bmvn\b|\bgradle\b|\bmake\b/
const DIFF_RE = /\bgit\s+diff\b/
const SHOW_RE = /\bgit\s+show\b/
const LOG_RE = /\b(?:journalctl|docker\s+logs|kubectl\s+logs)\b/
const SOURCE_RE = /\b(?:sed\s+-n|rg\b|grep\b|awk\b|jq\b)/
const STATUS_RE = /\b(?:ps|top|df|free|ss|netstat|systemctl\s+status|docker\s+ps|ip\s+(?:addr|a|route))\b/

function explicitBudget(command) {
  const first = String(command || '').trimStart().split('\n', 1)[0]
  const m = first.match(/^#\s*dsh-budget\s*[=:]\s*(\d{3,6})\b/i)
  if (!m) return null
  return Number(m[1])
}

export function classifyCommand(command) {
  const text = String(command || '').trim()
  if (!text) return 'default'
  if (explicitBudget(text) !== null) return 'explicit'
  if (UNBOUNDED_PATTERNS.some(re => re.test(text))) return 'unbounded'
  if (BUILD_RE.test(text)) return 'build'
  if (DIFF_RE.test(text)) return 'diff'
  if (SHOW_RE.test(text)) return 'source'
  if (LOG_RE.test(text)) {
    if (/(?:^|\s)(?:--since|-n\s*\d+|--lines(?:=|\s)\d+|--tail(?:=|\s)\d+)\b/.test(text)) return 'logs'
    return 'unbounded'
  }
  if (SOURCE_RE.test(text)) return 'source'
  if (STATUS_RE.test(text)) return 'status'
  return 'default'
}

export function budgetFor(command, isError, config = {}) {
  const hardMax = Number(config.hardMaxChars) || DEFAULT_HARD_MAX
  const declared = explicitBudget(command)
  if (declared !== null) return clamp(declared, 1000, hardMax)

  const category = classifyCommand(command)
  const defaults = { ...DEFAULT_CATEGORY_BUDGETS, ...(config.categoryBudgets || {}) }
  if (category === 'default' && !config.categoryBudgets?.default && Number(config.thresholdChars)) {
    defaults.default = Number(config.thresholdChars)
  }
  let budget = Number(defaults[category]) || DEFAULT_THRESHOLD
  if (isError) budget = Math.max(budget, Number(config.errorBudgetChars) || DEFAULT_ERROR_BUDGET)
  return clamp(budget, 500, hardMax)
}

/** 渲染有界摘要；保证输出总长度不超过 budget（路径和头尾都计入）。 */
export function renderBounded(text, options = {}) {
  const source = String(text || '')
  const budget = Math.max(500, Number(options.budget) || DEFAULT_THRESHOLD)
  const header = String(options.header || '')
  const footer = String(options.footer || '')
  const marker = '\n\n[... middle clipped by dsh-context-guard ...]\n\n'
  const overhead = header.length + footer.length + marker.length
  if (source.length + header.length + footer.length <= budget) return header + source + footer

  const available = budget - overhead
  if (available <= 0) return (header + footer).slice(0, budget)
  const wantedHead = Number(options.headChars) || DEFAULT_HEAD
  const wantedTail = Number(options.tailChars) || DEFAULT_TAIL
  const totalWanted = wantedHead + wantedTail
  const head = Math.max(0, Math.floor(available * (wantedHead / totalWanted)))
  const tail = Math.max(0, available - head)
  return header + source.slice(0, head) + marker + source.slice(-tail) + footer
}
