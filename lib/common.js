/** 通用小工具：文本提取、路径安全化、命令参数与哈希。 */
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function safeName(value, fallback = 'session') {
  return String(value || '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || fallback
}

export function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

export function commandOf(exec) {
  const args = exec?.arguments
  if (typeof args === 'string') return args
  if (args && typeof args === 'object' && typeof args.command === 'string') return args.command
  return ''
}

export function sessionIdOf(exec) {
  return exec?.agent?.id || exec?.agent?.session?.id || 'unknown-session'
}

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function hashText(text) {
  return createHash('sha256').update(String(text)).digest('hex')
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}
