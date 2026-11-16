/**
 * 通用工具：文件哈希、JSON 原子写、目录复制/哈希、Windows junction、
 * 版本范围粗判、进程探测、时间与 id。
 *
 * 本文件不依赖任何 @deepseek-ai/* 包，可被 CLI / 工具 / 测试直接使用。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'

export const isWindows = process.platform === 'win32'

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file))
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now()
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
  fs.renameSync(tmp, file)
}

export function writeTextAtomic(file, text) {
  ensureDir(path.dirname(file))
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now()
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

export function sha256File(file) {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.allocUnsafe(1024 * 1024)
  try {
    let n
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n))
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

export function sha256Text(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

export function nowIso() {
  return new Date().toISOString()
}

export function runId(prefix = 'run') {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const stamp =
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    '-' +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  return `${prefix}-${stamp}-${crypto.randomBytes(2).toString('hex')}`
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function isAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error && error.code === 'EPERM'
  }
}

export function listFiles(dir, options = {}) {
  const { skip = [], maxFiles = 20000, withStat = false } = options
  const out = []
  const skipSet = new Set(skip.map((s) => path.resolve(s).toLowerCase()))
  const skipNames = new Set(skip.filter((s) => !/[\\/]/.test(s)).map((s) => s.toLowerCase()))
  const walk = (current) => {
    if (out.length >= maxFiles) return
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      const lower = full.toLowerCase()
      if (skipSet.has(lower) || skipNames.has(entry.name.toLowerCase())) continue
      if (entry.isSymbolicLink()) {
        out.push(withStat ? { path: full, size: 0, mtimeMs: 0, link: true } : full)
        continue
      }
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile()) {
        if (withStat) {
          const st = fs.statSync(full)
          out.push({ path: full, size: st.size, mtimeMs: st.mtimeMs, link: false })
        } else {
          out.push(full)
        }
      }
    }
  }
  walk(path.resolve(dir))
  return out
}

export function hashTree(dir, options = {}) {
  const files = listFiles(dir, { ...options, withStat: true })
  const rows = files
    .map((f) => {
      if (f.link) return `${path.relative(dir, f.path).replace(/\\/g, '/')}|link`
      return `${path.relative(dir, f.path).replace(/\\/g, '/')}|${f.size}|${sha256File(f.path)}`
    })
    .sort()
  return sha256Text(rows.join('\n'))
}

export function copyTree(src, dest, options = {}) {
  const { filter = null } = options
  ensureDir(dest)
  const entries = fs.readdirSync(src, { withFileTypes: true })
  for (const entry of entries) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (filter && !filter(from, entry)) continue
    if (entry.isSymbolicLink()) {
      const target = fs.readlinkSync(from)
      try {
        fs.symlinkSync(target, to, 'junction')
      } catch {
        /* 已存在或权限不足时忽略 */
      }
      continue
    }
    if (entry.isDirectory()) {
      const st = fs.statSync(from)
      // 目录 junction（Windows 上 isDirectory + 无 symbolic 标志）——这里用 lstat 判断
      if (st.isDirectory() && entry.isDirectory()) {
        copyTree(from, to, options)
      }
    } else if (entry.isFile()) {
      ensureDir(path.dirname(to))
      fs.copyFileSync(from, to)
    }
  }
}

export function junction(target, linkPath) {
  ensureDir(path.dirname(linkPath))
  if (fs.existsSync(linkPath)) return
  fs.symlinkSync(path.resolve(target), linkPath, 'junction')
}

/**
 * 删除目录树，但**永不跟随** symbolic link / junction。
 *
 * 沙盒的基线、运行副本里 `runtimes/windows-x64/{node,dsh,bin}` 和 `packages`
 * 都是 junction，指向沙盒真正的运行时。`fs.rmSync(target, {recursive:true})`
 * 在重命名过的旧基线里会沿 junction 递归，把 node.exe / 核心一起删掉 ——
 * 这正是「沙盒跑一次 install_test 运行时就消失」的根因（探针实测：
 * rmrf(baseline-old-…) 前 node.exe 在，7 秒后不见了）。
 * 这里改成逐项 lstat：reparse point 只删链接本身，真目录才递归进去。
 */
export function rmrf(target) {
  if (!fs.existsSync(target)) return

  const sleep = (ms) => {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
    } catch {
      /* ignore */
    }
  }

  const withRetry = (fn) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        fn()
        return true
      } catch {
        if (attempt === 2) return false
        sleep(200)
      }
    }
    return false
  }

  const removeLink = (p) => {
    // junction 用 rmdir 删链接本身；symbolic link 用 unlink
    if (!withRetry(() => fs.unlinkSync(p))) withRetry(() => fs.rmdirSync(p))
  }

  const walk = (p) => {
    let st
    try {
      st = fs.lstatSync(p)
    } catch {
      return
    }
    if (st.isSymbolicLink()) {
      removeLink(p)
      return
    }
    if (!st.isDirectory()) {
      withRetry(() => fs.unlinkSync(p))
      return
    }
    let entries = []
    try {
      entries = fs.readdirSync(p)
    } catch {
      entries = []
    }
    for (const name of entries) walk(path.join(p, name))
    withRetry(() => fs.rmdirSync(p))
  }

  walk(target)

  // 最后兜底：仍有残留（例如被占用）时，只在本路径不是 reparse point 时才用原生递归
  if (fs.existsSync(target)) {
    let stillReparse = false
    try {
      stillReparse = fs.lstatSync(target).isSymbolicLink()
    } catch {
      stillReparse = false
    }
    if (!stillReparse) {
      try {
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      } catch {
        /* ignore */
      }
    }
  }
}

export function sizeOf(dir) {
  let total = 0
  for (const f of listFiles(dir, { withStat: true })) total += f.size
  return total
}

export function formatBytes(n) {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`
}

export function exec(cmd, args, options = {}) {
  const started = Date.now()
  const result = spawnSync(cmd, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeout || 10 * 60 * 1000,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  })
  return {
    ok: result.status === 0,
    code: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? String(result.error.message || result.error) : null,
    durationMs: Date.now() - started,
  }
}

/** 极简 semver 比较：支持 1.2.3 / 1.2.3-rc.1，忽略 build。 */
export function parseVersion(v) {
  const m = String(v || '')
    .trim()
    .match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/)
  if (!m) return null
  return {
    major: Number(m[1] || 0),
    minor: Number(m[2] || 0),
    patch: Number(m[3] || 0),
    pre: m[4] ? m[4].split('.') : [],
  }
}

function comparePre(a, b) {
  if (!a.length && !b.length) return 0
  if (!a.length) return 1 // 正式版 > 预发布
  if (!b.length) return -1
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

export function compareVersion(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return 0
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1
  }
  return comparePre(x.pre, y.pre)
}

/** 支持 >=, >, <=, <, =, ^, ~, 精确版本, * */
export function satisfies(version, range) {
  const r = String(range || '').trim()
  if (!r || r === '*' || r === 'latest') return true
  const parts = r.split(/\s+/).filter(Boolean)
  return parts.every((part) => satisfiesOne(version, part))
}

function satisfiesOne(version, token) {
  const m = token.match(/^(>=|<=|>|<|=|\^|~)?\s*(.+)$/)
  if (!m) return true
  const op = m[1] || '='
  const target = m[2].trim()
  if (target === '*' || target === 'x') return true
  const t = parseVersion(target)
  if (!t) return true
  const c = compareVersion(version, target)
  if (op === '>=') return c >= 0
  if (op === '>') return c > 0
  if (op === '<=') return c <= 0
  if (op === '<') return c < 0
  if (op === '=') {
    const v = parseVersion(version)
    return v && v.major === t.major && v.minor === t.minor && v.patch === t.patch
  }
  if (op === '^') {
    const v = parseVersion(version)
    if (!v) return false
    if (c < 0) return false
    if (t.major > 0) return v.major === t.major
    if (t.minor > 0) return v.major === 0 && v.minor === t.minor
    return v.major === 0 && v.minor === 0 && v.patch === t.patch
  }
  if (op === '~') {
    const v = parseVersion(version)
    if (!v || c < 0) return false
    return v.major === t.major && v.minor === t.minor
  }
  return true
}

/** 读取 zstd 会话文件为文本行。 */
export function readZstdText(file) {
  const compressed = fs.readFileSync(file)
  let buf
  if (typeof zlib.zstdDecompressSync === 'function') {
    buf = zlib.zstdDecompressSync(compressed)
  } else {
    throw new Error('当前 Node 不支持 zstd 解压')
  }
  return buf.toString('utf8')
}

export function inspectSessionFile(file) {
  try {
    const text = readZstdText(file)
    const lines = text.split(/\r?\n/).filter(Boolean)
    let bad = 0
    for (const line of lines) {
      try {
        JSON.parse(line)
      } catch {
        bad++
      }
    }
    return { ok: bad === 0, bytes: fs.statSync(file).size, lines: lines.length, badLines: bad }
  } catch (error) {
    return { ok: false, bytes: fs.existsSync(file) ? fs.statSync(file).size : 0, error: String(error.message || error) }
  }
}

export function tailFile(file, lines = 80) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    return text.split(/\r?\n/).slice(-lines).join('\n')
  } catch {
    return ''
  }
}

export function stripAnsi(text) {
  return String(text || '').replace(/\u001b\[[0-9;]*m/g, '')
}
