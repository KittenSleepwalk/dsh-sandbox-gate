import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, readJson, writeJsonAtomic, listFiles, sha256File, hashTree, runId, nowIso, sizeOf, satisfies, copyTree } from './util.js'
import { runPnpm } from './baseline.js'

// 主机绝对路径探测：只认「像主机路径」的形状，不写死任何具体用户名或盘符。
const HOST_PATH_PATTERNS = [
  /[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}[^\\/\s'"]+/i,
  /[A-Za-z]:[\\/]{1,2}(?:Program Files|Windows|ProgramData)[\\/]/i,
  /\\.dsh[\\/]{1,2}profiles[\\/]{1,2}[^\\/\s'"]+/i,
  /AppData[\\/]{1,2}Roaming[\\/]{1,2}dsh-tauri/i,
]

const DANGEROUS = [
  { re: /process\.exit\s*\(/, id: 'A08a', severity: 'warn', message: '包含 process.exit()，可能直接杀死沙盒进程' },
  { re: /\.listen\s*\(\s*(8889|18787)\b/, id: 'A08b', severity: 'blocker', message: '尝试监听主机保留端口 8889/18787' },
  { re: /deepseek-harness-pkg-windows\.asar/i, id: 'A08c', severity: 'blocker', message: '读取主机 asar 包' },
  { re: /require\s*\(\s*['"]child_process['"]\s*\)|from\s+['"]node:child_process['"]/, id: 'A08d', severity: 'warn', message: '使用子进程能力，需确认不会操作主机' },
]

const TEXT_EXT = /\.(js|mjs|cjs|ts|json|yml|yaml|md|txt|ps1|sh|cmd|bat|html|css)$/i

export function auditCandidate(paths, config, options = {}) {
  const log = options.log || (() => {})
  const target = options.path ? path.resolve(options.path) : null
  if (target && !fs.existsSync(target)) return { verdict: 'reject', findings: [{ id: 'A00', severity: 'blocker', message: `路径不存在：${target}` }], summary: 'path missing' }

  let auditDir = target
  let cleanup = null
  if (!auditDir) {
    if (!options.spec) return { verdict: 'reject', findings: [{ id: 'A00', severity: 'blocker', message: '需要 path 或 spec' }], summary: 'no target' }
    const cacheRoot = paths.ensure(path.join(paths.gate, 'audit-cache'), { mustBeGate: true })
    const dir = path.join(cacheRoot, runId('audit'))
    ensureDir(dir)
    const pkg = { name: 'gate-audit-cache', private: true, dependencies: {} }
    writeJsonAtomic(path.join(dir, 'package.json'), pkg)
    log(`审计下载：${options.spec}`)
    const result = runPnpm(config, dir, ['add', options.spec, '--ignore-scripts'], log, 10 * 60 * 1000)
    if (!result.ok) {
      return { verdict: 'reject', findings: [{ id: 'A00', severity: 'blocker', message: '下载/解包候选失败', detail: (result.stderr || '').slice(-1500) }], summary: 'download failed' }
    }
    const nm = path.join(dir, 'node_modules')
    const candidates = fs
      .readdirSync(nm, { withFileTypes: true })
      .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith('.'))
    let found = null
    for (const entry of candidates) {
      // pnpm 隔离布局下包是 symlink，Dirent.isDirectory() 为 false，这里统一按真实路径找 package.json。
      if (entry.name.startsWith('@')) {
        for (const sub of fs.readdirSync(path.join(nm, entry.name))) {
          const p = path.join(nm, entry.name, sub)
          if (fs.existsSync(path.join(p, 'package.json'))) found = found || p
        }
      } else {
        const p = path.join(nm, entry.name)
        if (fs.existsSync(path.join(p, 'package.json'))) found = found || p
      }
    }
    if (!found) return { verdict: 'reject', findings: [{ id: 'A00', severity: 'blocker', message: '下载后找不到包目录' }], summary: 'no package' }
    auditDir = fs.realpathSync(found)
    cleanup = dir
  }

  const findings = []
  const pkgPath = path.join(auditDir, 'package.json')
  if (!fs.existsSync(pkgPath)) {
    return { verdict: 'reject', findings: [{ id: 'A01', severity: 'blocker', message: '缺少 package.json' }], summary: 'not a package' }
  }
  const pkg = readJson(pkgPath, null)
  if (!pkg || !pkg.name) findings.push({ id: 'A01', severity: 'blocker', message: 'package.json 不合法或缺少 name' })

  checkEntryPoints(pkg, auditDir, findings)
  checkPatch(pkg, auditDir, paths, findings)
  checkEngines(pkg, config, paths, findings)
  scanFiles(auditDir, pkg, findings, log)
  checkLinks(auditDir, findings)

  const files = listFiles(auditDir, { withStat: true })
  const total = files.reduce((n, f) => n + f.size, 0)
  if (total > 50 * 1024 * 1024) findings.push({ id: 'A11', severity: 'warn', message: `包体偏大：${(total / 1024 / 1024).toFixed(1)}MB` })
  if (files.length > 5000) findings.push({ id: 'A11', severity: 'warn', message: `文件数偏多：${files.length}` })
  if (pkg.scripts && ['preinstall', 'install', 'postinstall'].some((k) => pkg.scripts[k])) {
    findings.push({
      id: 'A09',
      severity: 'warn',
      message: '包含 install 生命周期脚本，沙盒默认 --ignore-scripts',
      detail: ['preinstall', 'install', 'postinstall'].filter((k) => pkg.scripts[k]).join(','),
    })
  }

  const gpuLikely = detectGpuHints(pkg, auditDir)
  if (gpuLikely.likely) {
    findings.push({
      id: 'A13',
      severity: 'warn',
      message: '检测到硬件（GPU）依赖，安装测试前会轮询显卡空闲度',
      detail: gpuLikely.evidence.join(', '),
    })
  }

  const blockers = findings.filter((f) => f.severity === 'blocker')
  const verdict = blockers.length ? 'reject' : findings.some((f) => f.severity === 'warn') ? 'warn' : 'ok'
  const summary = `${pkg.name || '?'}@${pkg.version || '?'}：${findings.filter((f) => f.severity === 'blocker').length} blocker, ${findings.filter((f) => f.severity === 'warn').length} warn`
  const result = {
    verdict,
    name: pkg.name || null,
    version: pkg.version || null,
    dir: auditDir,
    auditedAt: nowIso(),
    summary,
    findings,
    contentHash: safeHash(auditDir),
    gpuLikely,
  }
  if (cleanup) result.cacheDir = cleanup
  return result
}

const GPU_DEP_RE = /(torch|cuda|diffusers|comfyui|comfy|onnxruntime-gpu|stable-diffusion|tensorrt|nvidia|cudnn|gpu)/i
const GPU_TEXT_RE = /(nvidia-smi|torch\.cuda|cuda|diffusers|comfyui|comfy\.|stable-diffusion|onnxruntime-gpu|gpu device|vram)/i
const GPU_TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.json', '.py', '.yml', '.yaml', '.md'])

/**
 * 判断插件是否要用本机显卡。仅作“是否需要显卡门控”的提示，
 * 不参与安全判定：真正确认靠 GPU 轮询 + 用户中断。
 */
export function detectGpuHints(pkg, dir) {
  const evidence = []
  const depNames = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}), ...(pkg.peerDependencies || {}) })
  for (const name of depNames) {
    if (GPU_DEP_RE.test(name)) evidence.push(`dep:${name}`)
  }
  const words = [pkg.name, pkg.description, ...(Array.isArray(pkg.keywords) ? pkg.keywords : [])].filter(Boolean).join(' ')
  if (GPU_TEXT_RE.test(words)) evidence.push('package-meta')
  const files = listFiles(dir, { withStat: true })
  for (const f of files) {
    if (evidence.length >= 6) break
    if (!GPU_TEXT_EXT.has(path.extname(f.path || f.rel || '').toLowerCase())) continue
    if ((f.size || 0) > 256 * 1024) continue
    try {
      const text = fs.readFileSync(f.path || path.join(dir, f.rel), 'utf8')
      const m = text.match(GPU_TEXT_RE)
      if (m) evidence.push(`${path.basename(f.path || f.rel)}:${m[0]}`)
    } catch {
      /* 忽略不可读文件 */
    }
  }
  return { likely: evidence.length > 0, evidence: [...new Set(evidence)] }
}

function safeHash(dir) {
  try {
    return hashTree(dir, { skip: ['node_modules'] })
  } catch {
    return null
  }
}

function checkEntryPoints(pkg, dir, findings) {
  const entries = []
  if (typeof pkg.main === 'string') entries.push(pkg.main)
  if (typeof pkg.exports === 'string') entries.push(pkg.exports)
  if (pkg.exports && typeof pkg.exports === 'object') {
    for (const value of Object.values(pkg.exports)) {
      if (typeof value === 'string') entries.push(value)
      else if (value && typeof value === 'object') {
        for (const v of Object.values(value)) if (typeof v === 'string') entries.push(v)
      }
    }
  }
  for (const rel of entries) {
    // exports 里的通配映射（如 ./locale/*.json）不是实体文件，跳过。
    if (/[*?[\]]/.test(rel) || rel.endsWith('/')) continue
    const file = path.join(dir, rel.replace(/^\.\//, ''))
    if (!fs.existsSync(file)) findings.push({ id: 'A02', severity: 'blocker', message: `入口不存在：${rel}` })
  }
}

function checkPatch(pkg, dir, paths, findings) {
  const bundle = pkg.dsh && pkg.dsh.bundle
  const rel = bundle && bundle.patch
  if (!rel) {
    findings.push({ id: 'A03', severity: 'warn', message: '未声明 dsh.bundle.patch，安装后可能不会自动挂载' })
    return
  }
  const file = path.join(dir, rel.replace(/^\.\//, ''))
  if (!fs.existsSync(file)) {
    findings.push({ id: 'A03', severity: 'blocker', message: `dsh.bundle.patch 指向的文件不存在：${rel}` })
    return
  }
  const text = fs.readFileSync(file, 'utf8')
  if (!/insert\s*:/.test(text)) findings.push({ id: 'A03', severity: 'warn', message: 'patch 中没有 insert:，可能只做配置覆盖' })
  const ids = [...text.matchAll(/^\s*-\s*id\s*:\s*([^\s#]+)/gm)].map((m) => m[1].replace(/^['"]|['"]$/g, ''))
  if (!ids.length) findings.push({ id: 'A04', severity: 'warn', message: 'patch 中未解析到 id' })
  // 与基线冲突检查
  const baseline = readJson(paths.baselineManifest)
  if (baseline) {
    const known = new Set()
    for (const b of baseline.bundles || []) known.add(b)
    const profilePkg = readJson(path.join(baseline.baselineRoot, 'data', 'dsh-home', 'profiles', baseline.profile, 'package.json'), {})
    const depIds = Object.keys((profilePkg && profilePkg.dependencies) || {})
    for (const id of depIds) known.add(id)
    const conflict = ids.filter((id) => known.has(id))
    if (conflict.length) {
      findings.push({ id: 'A10', severity: 'blocker', message: `patch id 与基线冲突：${conflict.join(', ')}` })
    }
  }
}

function checkEngines(pkg, config, paths, findings) {
  const range = pkg.dsh && pkg.dsh.engines && pkg.dsh.engines.dsh
  if (!range) {
    findings.push({ id: 'A05', severity: 'warn', message: '未声明 dsh.engines.dsh' })
    return
  }
  const inventory = readJson(paths.hostInventory)
  const core = (inventory && inventory.host && inventory.host.coreVersion) || config.coreVersion || '0.2.2-rc.1'
  if (!satisfies(core, range)) {
    findings.push({ id: 'A05', severity: 'blocker', message: `引擎范围 ${range} 不包含核心 ${core}` })
  }
}

function scanFiles(dir, pkg, findings, log) {
  const files = listFiles(dir, { skip: ['node_modules', '.git'], maxFiles: 800 })
  let scanned = 0
  for (const file of files) {
    if (!TEXT_EXT.test(file)) continue
    let text
    try {
      const st = fs.statSync(file)
      if (st.size > 1024 * 1024) continue
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    scanned++
    const rel = path.relative(dir, file).replace(/\\/g, '/')
    for (const pattern of HOST_PATH_PATTERNS) {
      if (pattern.test(text)) {
        findings.push({ id: 'A07', severity: 'blocker', file: rel, message: `包含主机绝对路径（${pattern}）` })
      }
    }
    for (const rule of DANGEROUS) {
      if (rule.re.test(text)) findings.push({ id: rule.id, severity: rule.severity, file: rel, message: rule.message })
    }
  }
  log(`静态扫描 ${scanned} 个文本文件`)
  if (scanned > 0) {
    const entry = typeof pkg.main === 'string' ? path.join(dir, pkg.main) : null
    if (entry && fs.existsSync(entry)) {
      const src = fs.readFileSync(entry, 'utf8')
      if (!/export\s+(const\s+apply|function\s+apply|\{[^}]*apply)/.test(src) && !/module\.exports\s*=/.test(src)) {
        findings.push({ id: 'A12', severity: 'warn', file: pkg.main, message: '入口未见 apply 导出，可能不是 cordis 插件' })
      }
    }
  }
}

function checkLinks(dir, findings) {
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isSymbolicLink()) {
        let target = ''
        try {
          target = fs.realpathSync(full)
        } catch {
          target = fs.readlinkSync(full)
        }
        const inside = path.resolve(target).toLowerCase().startsWith(path.resolve(dir).toLowerCase() + path.sep)
        if (!inside) findings.push({ id: 'A10', severity: 'blocker', file: full, message: `符号链接指向包外：${target}` })
        continue
      }
      if (entry.isDirectory() && !['node_modules', '.git'].includes(entry.name)) walk(full)
    }
  }
  try {
    walk(dir)
  } catch {
    /* ignore */
  }
}

export function auditVerdictForInstall(audit, force) {
  if (!audit) return { allowed: false, reason: '缺少审计结果' }
  if (audit.verdict === 'reject' && !force) return { allowed: false, reason: '静态审计 reject，默认拒绝安装（force=true 可强制）' }
  return { allowed: true }
}
