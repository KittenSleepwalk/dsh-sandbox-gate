import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, readJson, sha256File, writeJsonAtomic, writeTextAtomic, nowIso, listFiles } from './util.js'

const SOURCE_URL = 'https://github.com/techjarves/Deepseek-Harness-Portable'

/**
 * 备份 portable 发行文件（不含 runtimes/data/packages —— 那些是首次运行下载的）。
 * 目的：GitHub 不可达或作者删库时，仍可重建沙盒入口与脚本。
 */
export function buildBackup(paths, config) {
  const manifestPath = path.join(config.sandboxRoot, 'scripts', 'manifest.json')
  const manifest = readJson(manifestPath, {}) || {}
  const version = String(manifest.portableVersion || 'unknown')
  const dest = path.join(paths.backup, `portable-${version}`)
  if (fs.existsSync(path.join(dest, 'SHA256SUMS.json'))) {
    return { ok: true, skipped: true, dest, version }
  }
  ensureDir(dest)

  const roots = [
    'windows.bat',
    'linux.sh',
    'mac.sh',
    'README.md',
    'LICENSE',
    'LICENSE.md',
    '.github',
    'scripts',
  ]
  const copied = []
  for (const rel of roots) {
    const src = path.join(config.sandboxRoot, rel)
    if (!fs.existsSync(src)) continue
    copyEntry(src, path.join(dest, rel), copied, dest)
  }

  const files = copied
    .filter((p) => fs.statSync(p).isFile())
    .map((p) => ({ path: path.relative(dest, p).replace(/\\/g, '/'), sha256: sha256File(p), size: fs.statSync(p).size }))
    .sort((a, b) => a.path.localeCompare(b.path))

  writeJsonAtomic(path.join(dest, 'SHA256SUMS.json'), {
    version: 1,
    portableVersion: version,
    sourceUrl: SOURCE_URL,
    capturedAt: nowIso(),
    note: '仅备份 portable 发行脚本/说明，不含首次运行批量下载的 node/dsh/packages。',
    files,
  })
  writeJsonAtomic(path.join(dest, 'provenance.json'), {
    sourceUrl: SOURCE_URL,
    release: manifest.release || null,
    portableVersion: version,
    deepseekHarness: manifest.deepseekHarness || null,
    node: manifest.node || null,
    capturedAt: nowIso(),
    sandboxRoot: config.sandboxRoot,
  })
  writeTextAtomic(
    path.join(dest, 'README.md'),
    [
      '# Deepseek Harness SandBox — 原始发行文件备份',
      '',
      `- 来源：${SOURCE_URL}`,
      `- portableVersion：${version}`,
      `- 备份时间：${nowIso()}`,
      '- 内容：启动脚本、scripts/、.github/、README；**不含** runtimes/node/dsh/packages（这些是首次运行下载的）。',
      '- 用途：GitHub 不可达或上游删库时，仍可核对/恢复沙盒脚本入口。',
      '- 校验：`node dsh-sandbox-gate/bin/gate.mjs backup-verify`。',
      '',
    ].join('\n'),
  )

  return { ok: true, dest, version, files: files.length }
}

function copyEntry(src, dest, copied, backupRoot) {
  const st = fs.statSync(src)
  if (st.isDirectory()) {
    ensureDir(dest)
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      copyEntry(path.join(src, entry.name), path.join(dest, entry.name), copied, backupRoot)
    }
    return
  }
  if (!st.isFile()) return
  ensureDir(path.dirname(dest))
  fs.copyFileSync(src, dest)
  copied.push(dest)
}

export function verifyBackup(paths) {
  if (!fs.existsSync(paths.backup)) {
    return { ok: false, error: '备份目录不存在，请先运行 calibrate（会自动建立备份）' }
  }
  const dirs = fs
    .readdirSync(paths.backup, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('portable-'))
    .map((d) => path.join(paths.backup, d.name))
  if (!dirs.length) return { ok: false, error: '没有 portable-* 备份' }
  const reports = []
  for (const dir of dirs) {
    const sumsPath = path.join(dir, 'SHA256SUMS.json')
    const sums = readJson(sumsPath)
    if (!sums || !Array.isArray(sums.files)) {
      reports.push({ dir, ok: false, error: '缺少 SHA256SUMS.json' })
      continue
    }
    const bad = []
    for (const item of sums.files) {
      const file = path.join(dir, item.path)
      if (!fs.existsSync(file)) bad.push({ path: item.path, error: 'missing' })
      else if (sha256File(file) !== item.sha256) bad.push({ path: item.path, error: 'sha256-mismatch' })
    }
    reports.push({ dir, ok: bad.length === 0, files: sums.files.length, portableVersion: sums.portableVersion, bad })
  }
  return { ok: reports.every((r) => r.ok), reports }
}

export function latestBackupDir(paths) {
  if (!fs.existsSync(paths.backup)) return null
  const dirs = fs
    .readdirSync(paths.backup, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('portable-'))
    .map((d) => path.join(paths.backup, d.name))
    .sort()
  return dirs.length ? dirs[dirs.length - 1] : null
}
