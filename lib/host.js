import fs from 'node:fs'
import path from 'node:path'
import { exec, sha256File, sha256Text, readJson, writeJsonAtomic, nowIso } from './util.js'
import { assertSandbox } from './config.js'

/** 从 asar 头里取 @deepseek-ai/dsh 的 package.json（不解包 447MB）。 */
export function readAsarDshVersion(asarPath) {
  if (!fs.existsSync(asarPath)) return { ok: false, error: 'asar 不存在' }
  let fd
  // 在 DSH Desktop（Electron 内置 node）里 fs 会把 .asar 当目录重定向，必须临时关闭。
  const prevNoAsar = process.noAsar
  try {
    process.noAsar = true
    fd = fs.openSync(asarPath, 'r')
    const head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    const headerSize = head.readUInt32LE(4)
    // Chromium Pickle: [4][headerSize][header payload 4][json length 4][json...]
    const jsonLen = head.readUInt32LE(12)
    if (!headerSize || headerSize > 64 * 1024 * 1024 || jsonLen > headerSize) {
      return { ok: false, error: 'asar 头长度异常' }
    }
    const raw = Buffer.alloc(jsonLen)
    fs.readSync(fd, raw, 0, jsonLen, 16)
    const json = JSON.parse(raw.toString('utf8'))
    const dataStart = 8 + headerSize
    const target = findAsarFile(json, /node_modules[\\/]@deepseek-ai[\\/]dsh[\\/]package\.json$/)
    if (!target) return { ok: false, error: 'asar 中找不到 @deepseek-ai/dsh/package.json' }
    const buf = Buffer.alloc(target.size)
    fs.readSync(fd, buf, 0, target.size, dataStart + Number(target.offset))
    const pkg = JSON.parse(buf.toString('utf8'))
    return { ok: true, version: pkg.version, engines: pkg.engines || {}, files: Object.keys(json.files || {}).length }
  } catch (error) {
    return { ok: false, error: String(error.message || error) }
  } finally {
    process.noAsar = prevNoAsar
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

function findAsarFile(node, re, prefix = '') {
  if (!node || typeof node !== 'object') return null
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) {
      const p = prefix ? prefix + '/' + name : name
      if (!child.files && child.size !== undefined && re.test(p.replace(/\\/g, '/'))) return child
      if (child.files) {
        const found = findAsarFile(child, re, p)
        if (found) return found
      }
    }
  }
  return null
}

export function classifySpec(name, spec, profileDir) {
  const value = String(spec || '')
  if (value.startsWith('link:')) {
    const raw = value.slice(5)
    const target = path.resolve(profileDir, raw)
    return { name, spec: value, kind: 'link', target, exists: fs.existsSync(target) }
  }
  if (value.startsWith('file:')) {
    const raw = value.slice(5)
    const target = path.resolve(profileDir, raw)
    return { name, spec: value, kind: 'file', target, exists: fs.existsSync(target) }
  }
  if (value.startsWith('github:') || value.includes('github.com')) {
    return { name, spec: value, kind: 'github' }
  }
  if (/^https?:/.test(value)) return { name, spec: value, kind: 'url' }
  return { name, spec: value, kind: 'registry' }
}

export function readHostProfile(config) {
  const dir = config.hostProfileDir
  const pkgPath = path.join(dir, 'package.json')
  if (!fs.existsSync(pkgPath)) throw new Error(`主机 profile 不存在：${pkgPath}`)
  const pkg = readJson(pkgPath, {})
  const deps = Object.entries(pkg.dependencies || {}).map(([name, spec]) =>
    classifySpec(name, spec, dir),
  )
  const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || []
  return { dir, pkg, pkgPath, deps, bundles }
}

function asarPath(config) {
  return path.join(
    path.resolve(config.hostDshHome),
    '..',
    'AppData',
    'Roaming',
    'dsh-tauri',
    'dependencies',
    'dsh',
    'deepseek-harness-pkg-windows.asar',
  )
}

export function detectHostCore(config) {
  if (config.coreVersion) return { version: config.coreVersion, source: 'config' }
  const candidates = [
    path.join(path.resolve(config.hostDshHome), '..', 'AppData', 'Roaming', 'dsh-tauri', 'dependencies', 'dsh', 'deepseek-harness-pkg-windows.asar'),
  ]
  // 回退候选：用系统的 APPDATA，而不是写死某个账户目录。
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'dsh-tauri', 'dependencies', 'dsh', 'deepseek-harness-pkg-windows.asar'))
  }
  for (const candidate of candidates) {
    const result = readAsarDshVersion(candidate)
    if (result.ok) return { version: result.version, source: 'asar', asarPath: candidate, engines: result.engines }
  }
  return { version: null, source: 'none', error: '无法解析主机核心版本，请设置 DSH_GATE_CORE_VERSION' }
}

export function hostFingerprint(config) {
  const parts = []
  const pkgPath = path.join(config.hostProfileDir, 'package.json')
  if (fs.existsSync(pkgPath)) parts.push('pkg:' + sha256File(pkgPath))
  const compat = path.join(config.hostProfileDir, 'compatibility.json')
  if (fs.existsSync(compat)) parts.push('compat:' + sha256File(compat))
  const asar = asarPath(config)
  if (fs.existsSync(asar)) {
    const st = fs.statSync(asar)
    parts.push(`asar:${st.size}:${Math.round(st.mtimeMs)}`)
  }
  return 'sha256:' + sha256Text(parts.sort().join('|'))
}

export function portOwner(port) {
  const r = exec('netstat', ['-ano', '-p', 'tcp'], { timeout: 15000 })
  if (!r.ok) return { ok: false, error: r.stderr || r.error }
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.trim().match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i)
    if (m && Number(m[1]) === Number(port)) return { ok: true, pid: Number(m[2]) }
  }
  return { ok: true, pid: null }
}

export function hostSnapshot(config) {
  const profile = readHostProfile(config)
  const core = detectHostCore(config)
  const guiPort = Number(process.env.DSH_GATE_HOST_PORT || 8889)
  return {
    fingerprint: hostFingerprint(config),
    profileDir: config.hostProfileDir,
    profileHash: sha256File(profile.pkgPath),
    deps: profile.deps.length,
    bundles: profile.bundles.length,
    coreVersion: core.version,
    coreSource: core.source,
    guiPort,
    guiPid: portOwner(guiPort).pid || null,
    at: nowIso(),
  }
}

/** 校准：主机核心 + 插件清单 + 排除项 + 沙盒现状；结果缓存到 state。 */
export function calibrate(paths, config, options = {}) {
  assertSandbox(config)
  const profile = readHostProfile(config)
  const core = detectHostCore(config)
  if (!core.version) throw new Error(core.error || '无法确定主机核心版本')

  const excluded = []
  const installable = []
  for (const dep of profile.deps) {
    if (config.excludePlugins.includes(dep.name)) {
      excluded.push({ name: dep.name, reason: 'desktop-shell-only', spec: dep.spec })
      continue
    }
    if (dep.kind === 'link' && dep.target && !dep.exists) {
      excluded.push({ name: dep.name, reason: 'link-target-missing', target: dep.target })
      continue
    }
    if (dep.kind === 'link' && dep.target && /Deepseek Harness Desktop/i.test(dep.target) && /resources/i.test(dep.target)) {
      excluded.push({ name: dep.name, reason: 'desktop-resource-link', target: dep.target })
      continue
    }
    installable.push(dep)
  }

  const installableNames = new Set(installable.map((d) => d.name))
  const bundles = profile.bundles.filter((b) => installableNames.has(b) || b.startsWith('@deepseek-ai/dsh-'))
  // 核心基础 bundle 永远保留
  for (const base of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']) {
    if (!bundles.includes(base)) bundles.unshift(base)
  }

  const sessions = countSessions(path.join(config.sandboxRoot, 'data', 'dsh-home', 'sessions'))
  const inventory = {
    version: 1,
    calibratedAt: nowIso(),
    host: {
      profileDir: config.hostProfileDir,
      dshHome: config.hostDshHome,
      guiPort: Number(process.env.DSH_GATE_HOST_PORT || 8889),
      coreVersion: core.version,
      coreSource: core.source,
      asarPath: core.asarPath || null,
      profileHash: sha256File(profile.pkgPath),
      fingerprint: hostFingerprint(config),
    },
    deps: installable,
    bundles,
    excluded,
    installableCount: installable.length,
    excludedCount: excluded.length,
    sandbox: {
      root: config.sandboxRoot,
      coreVersion: sandboxCoreVersion(config),
      sessions,
      hasBackup: fs.existsSync(paths.backup) && fs.readdirSync(paths.backup).length > 0,
    },
    warnings: [],
  }

  paths.ensureLayout()
  writeJsonAtomic(paths.hostInventory, inventory)
  return inventory
}

function sandboxCoreVersion(config) {
  const pkg = path.join(
    config.sandboxRoot,
    'runtimes',
    'windows-x64',
    'dsh',
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'package.json',
  )
  return readJson(pkg, {}).version || null
}

export function countSessions(dir) {
  if (!fs.existsSync(dir)) return 0
  let n = 0
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/^session\.v\d+.*\.jsonl\.zstd$/i.test(entry.name)) n++
    }
  }
  walk(dir)
  return n
}

export function cachedInventory(paths, config, options = {}) {
  if (!options.force) {
    const cached = readJson(paths.hostInventory)
    if (cached && cached.host && cached.host.profileHash === sha256File(path.join(config.hostProfileDir, 'package.json')) && cached.host.coreVersion) {
      return { inventory: cached, cached: true }
    }
  }
  return { inventory: calibrate(paths, config, options), cached: false }
}
