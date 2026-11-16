import fs from 'node:fs'
import path from 'node:path'
import { inspectSessionFile, sha256File, listFiles } from './util.js'

export function scanSessions(dshHome) {
  const dir = path.join(dshHome, 'sessions')
  if (!fs.existsSync(dir)) {
    return { dir, exists: false, count: 0, files: [], corrupt: [], totalLines: 0 }
  }
  const files = listFiles(dir)
    .filter((f) => /session\.v\d+.*\.jsonl\.zstd$/i.test(f))
    .map((f) => {
      const rel = path.relative(dir, f).replace(/\\/g, '/')
      const info = inspectSessionFile(f)
      return {
        rel,
        bytes: info.bytes || 0,
        lines: info.lines || 0,
        badLines: info.badLines || 0,
        ok: Boolean(info.ok),
        error: info.error || null,
        sha256: safeSha(f),
      }
    })
  return {
    dir,
    exists: true,
    count: files.length,
    totalLines: files.reduce((n, f) => n + f.lines, 0),
    corrupt: files.filter((f) => !f.ok),
    files,
  }
}

function safeSha(file) {
  try {
    return sha256File(file)
  } catch {
    return null
  }
}

export function compareSessions(before, after) {
  const problems = []
  if (before.count > 0 && after.count < before.count) {
    problems.push(`session 数量减少：${before.count} → ${after.count}`)
  }
  const afterMap = new Map(after.files.map((f) => [f.rel, f]))
  for (const file of before.files) {
    const now = afterMap.get(file.rel)
    if (!now) {
      problems.push(`session 丢失：${file.rel}`)
      continue
    }
    if (file.ok && !now.ok) problems.push(`session 损坏：${file.rel}（${now.error || '解析失败'}）`)
    if (now.lines < file.lines) problems.push(`session 事件数减少：${file.rel} ${file.lines} → ${now.lines}`)
    if (now.bytes === 0) problems.push(`session 变成 0 字节：${file.rel}`)
  }
  for (const file of after.corrupt) {
    if (!before.files.find((f) => f.rel === file.rel)) problems.push(`新增 session 已损坏：${file.rel}`)
  }
  return {
    ok: problems.length === 0,
    problems,
    beforeCount: before.count,
    afterCount: after.count,
    beforeLines: before.totalLines,
    afterLines: after.totalLines,
    added: after.files.filter((f) => !before.files.find((b) => b.rel === f.rel)).map((f) => f.rel),
  }
}

export function sessionSetFingerprint(scan) {
  return scan.files
    .map((f) => `${f.rel}:${f.bytes}:${f.lines}`)
    .sort()
    .join('|')
}
