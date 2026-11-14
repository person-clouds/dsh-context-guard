/** 工具输出落盘清理：按保留期、单会话配额、全局配额删除最旧文件。 */
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const DEFAULT_CLEANUP = {
  retentionDays: 7,
  maxSessionBytes: 50 * 1024 * 1024,
  maxTotalBytes: 500 * 1024 * 1024,
  maxFilesPerSession: 300,
  keepRecentInActiveSession: 3,
}

async function scan(root) {
  const files = []
  let dirs = []
  try {
    dirs = await readdir(root, { withFileTypes: true })
  } catch {
    return { files, dirs: [] }
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const sessionDir = join(root, dir.name)
    let entries = []
    try {
      entries = await readdir(sessionDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const path = join(sessionDir, entry.name)
      try {
        const info = await stat(path)
        files.push({ session: dir.name, path, size: info.size, mtimeMs: info.mtimeMs })
      } catch {
        // 文件可能在扫描期间被删除，忽略。
      }
    }
  }
  return { files, dirs: dirs.filter(dir => dir.isDirectory()).map(dir => join(root, dir.name)) }
}

async function removeFiles(files) {
  let deleted = 0
  let bytesFreed = 0
  for (const file of files) {
    try {
      await rm(file.path, { force: true })
      deleted++
      bytesFreed += file.size
    } catch {
      // 清理失败不阻塞主流程。
    }
  }
  return { deleted, bytesFreed }
}

export async function cleanupOutputs(root, options = {}) {
  const cfg = { ...DEFAULT_CLEANUP, ...options }
  const { files, dirs } = await scan(root)
  if (files.length === 0) return { scanned: 0, deleted: 0, bytesFreed: 0 }

  const now = Number(cfg.now) || Date.now()
  const cutoff = now - Number(cfg.retentionDays) * 86400000
  const keep = new Set()
  const active = files
    .filter(file => file.session === cfg.currentSession)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, Math.max(1, Number(cfg.keepRecentInActiveSession) || 1))
  for (const file of active) keep.add(file.path)

  const toDelete = new Set()
  for (const file of files) {
    if (!keep.has(file.path) && file.mtimeMs < cutoff) toDelete.add(file.path)
  }

  const remaining = () => files.filter(file => !toDelete.has(file.path))
  const sessions = new Map()
  for (const file of remaining()) {
    if (!sessions.has(file.session)) sessions.set(file.session, [])
    sessions.get(file.session).push(file)
  }
  for (const list of sessions.values()) {
    list.sort((a, b) => a.mtimeMs - b.mtimeMs)
    let bytes = list.reduce((sum, file) => sum + file.size, 0)
    let count = list.length
    for (const file of list) {
      if (count <= Number(cfg.maxFilesPerSession) && bytes <= Number(cfg.maxSessionBytes)) break
      if (keep.has(file.path)) continue
      toDelete.add(file.path)
      bytes -= file.size
      count--
    }
  }

  let totalBytes = remaining().reduce((sum, file) => sum + file.size, 0)
  if (totalBytes > Number(cfg.maxTotalBytes)) {
    const ordered = remaining().sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const file of ordered) {
      if (totalBytes <= Number(cfg.maxTotalBytes)) break
      if (keep.has(file.path)) continue
      toDelete.add(file.path)
      totalBytes -= file.size
    }
  }

  const removed = await removeFiles(files.filter(file => toDelete.has(file.path)))
  for (const dir of dirs) {
    try {
      const left = await readdir(dir)
      if (left.length === 0) await rm(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
  return { scanned: files.length, ...removed }
}
