import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, readJson, writeJsonAtomic, copyTree, junction, rmrf, runId, nowIso, sha256File } from './util.js'
import { runPnpm } from './baseline.js'

function isJunction(p) {
  try {
    const st = fs.lstatSync(p)
    return st.isSymbolicLink()
  } catch {
    return false
  }
}

function removeJunction(p) {
  if (!fs.existsSync(p) && !isJunction(p)) return
  if (isJunction(p)) {
    try {
      fs.rmdirSync(p)
    } catch {
      try {
        fs.unlinkSync(p)
      } catch {
        /* ignore */
      }
    }
  } else {
    rmrf(p)
  }
}

/** 从基线复制一次性运行副本；runtimes/bin/packages 仅建 junction。 */
export function createRun(paths, config, baselineManifest, options = {}) {
  const log = options.log || (() => {})
  const id = runId('run')
  const dir = paths.ensure(paths.runDir(id), { mustBeGate: true })
  const root = paths.ensure(paths.runRoot(id), { mustBeGate: true })
  const srcRoot = baselineManifest.baselineRoot

  const linkDirs = ['runtimes/windows-x64/node', 'runtimes/windows-x64/dsh', 'runtimes/windows-x64/bin', 'packages']
  for (const rel of linkDirs) {
    const src = path.join(srcRoot, rel)
    if (!fs.existsSync(src)) continue
    let target
    try {
      target = fs.realpathSync(src)
    } catch {
      target = src
    }
    junction(target, path.join(root, rel))
  }

  for (const rel of ['data', 'scripts']) {
    const src = path.join(srcRoot, rel)
    if (fs.existsSync(src)) {
      copyTree(src, path.join(root, rel), {
        filter: (from, entry) => !['node_modules/.cache'].includes(entry.name),
      })
      log(`复制 ${rel}`)
    }
  }
  // pnpm 把 virtualStoreDir 的绝对路径记在 .modules.yaml 里；复制到新目录后必须改指
  // 新副本，否则 pnpm add 会拒绝在“另一个虚拟仓库”上继续安装。
  relocateVirtualStores(root)

  for (const rel of ['temp', 'logs', '.sandbox-gate/canary-out', 'state']) {
    ensureDir(path.join(root, rel))
  }

  const run = {
    version: 1,
    runId: id,
    createdAt: nowIso(),
    baselineFingerprint: baselineManifest.fingerprint,
    baselineRoot: srcRoot,
    root,
    profile: baselineManifest.profile,
    coreVersion: baselineManifest.coreVersion,
    candidate: options.candidate || null,
    port: null,
    stage: 'created',
    options: {
      restartCycles: options.restartCycles ?? config.restartCycles,
      stabilitySec: options.stabilitySec ?? config.stabilitySec,
      gpuWait: options.gpuWait !== false,
      allowInstallScripts: Boolean(options.allowInstallScripts),
    },
    tests: {},
  }
  writeJsonAtomic(path.join(dir, 'run.json'), run)
  return run
}

export function saveRun(paths, run) {
  run.updatedAt = nowIso()
  writeJsonAtomic(path.join(paths.runDir(run.runId), 'run.json'), run)
}

export function loadRun(paths, runIdValue) {
  const dir = paths.runDir(runIdValue)
  const run = readJson(path.join(dir, 'run.json'))
  if (!run) throw new Error(`run 不存在：${runIdValue}`)
  return run
}

/** 把候选复制进 run 的隔离目录，再 pnpm add；确保候选源码不被写入。 */
export function stageCandidate(paths, config, run, candidate, log = () => {}) {
  const profileDir = path.join(run.root, 'data', 'dsh-home', 'profiles', run.profile)
  let spec = candidate.spec
  let sourceCopy = null

  if (candidate.localPath) {
    const src = path.resolve(candidate.localPath)
    if (!fs.existsSync(path.join(src, 'package.json'))) {
      return { ok: false, error: `候选目录缺少 package.json：${src}` }
    }
    const pkg = readJson(path.join(src, 'package.json'), {})
    const dirName = String(pkg.name || path.basename(src)).replace(/[^0-9A-Za-z._-]/g, '_')
    const dest = path.join(run.root, '.sandbox-gate', 'candidate', dirName)
    ensureDir(dest)
    copyTree(src, dest, {
      filter: (from, entry) => !['node_modules', '.git', '.sandbox-gate', 'dist/.cache'].includes(entry.name),
    })
    sourceCopy = dest
    spec = dest
  }

  const args = ['add', spec, '--ignore-scripts']
  log(`安装候选：${spec}`)
  const result = runPnpm(config, profileDir, args, log, 15 * 60 * 1000)
  if (!result.ok) {
    log(`安装失败：${(result.stderr || result.stdout || result.error || '').slice(-2000)}`)
    return { ok: false, error: '候选安装失败', log: result, sourceCopy }
  }

  const pkgName = candidate.name || guessInstalledName(profileDir, sourceCopy)
  if (!pkgName) return { ok: false, error: '无法确定候选包名', sourceCopy }

  const installedPkg = readJson(path.join(profileDir, 'node_modules', pkgName, 'package.json'))
  if (!installedPkg) return { ok: false, error: `安装后 node_modules 中找不到 ${pkgName}`, sourceCopy }

  // 把候选加入 profile bundles，使其 cordis.patch.yml 被加载
  const profilePkgPath = path.join(profileDir, 'package.json')
  const profilePkg = readJson(profilePkgPath, {})
  const bundles = (profilePkg.dsh && profilePkg.dsh.profile && profilePkg.dsh.profile.bundles) || []
  const needsBundle = Boolean(installedPkg.dsh && installedPkg.dsh.bundle)
  if (needsBundle && !bundles.includes(pkgName)) {
    bundles.push(pkgName)
    profilePkg.dsh = { profile: { bundles } }
    writeJsonAtomic(profilePkgPath, profilePkg)
    log(`已加入 bundles：${pkgName}`)
  }

  // 留一份 profile patch 快照：resume 时若 patch 被半成品/异常退出写坏，可据此修复。
  const patchPath = path.join(profileDir, 'cordis.patch.yml')
  if (fs.existsSync(patchPath)) {
    const snapshot = path.join(run.root, '.sandbox-gate', 'profile-patch.yml')
    ensureDir(path.dirname(snapshot))
    fs.copyFileSync(patchPath, snapshot)
  }

  return {
    ok: true,
    packageName: pkgName,
    version: installedPkg.version || null,
    needsBundle,
    sourceCopy,
    spec: candidate.spec,
    installedAt: nowIso(),
  }
}

function relocateVirtualStores(root) {
  const profilesRoot = path.join(root, 'data', 'dsh-home', 'profiles')
  if (!fs.existsSync(profilesRoot)) return
  for (const entry of fs.readdirSync(profilesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const modulesYaml = path.join(profilesRoot, entry.name, 'node_modules', '.modules.yaml')
    if (!fs.existsSync(modulesYaml)) continue
    const modulesDir = path.join(profilesRoot, entry.name, 'node_modules', '.pnpm')
    try {
      const text = fs.readFileSync(modulesYaml, 'utf8')
      const next = text.replace(/("virtualStoreDir":\s*")[^"]*(")/, (_, a, b) => a + modulesDir.replace(/\\/g, '\\\\') + b)
      if (next !== text) fs.writeFileSync(modulesYaml, next, 'utf8')
    } catch {
      /* 目录不可写时保持原样，让安装阶段给出明确错误 */
    }
  }
}

function guessInstalledName(profileDir, sourceCopy) {  if (!sourceCopy) return null
  const pkg = readJson(path.join(sourceCopy, 'package.json'), {})
  return pkg.name || null
}

export function disposeRun(paths, run, options = {}) {
  const dir = paths.runDir(run.runId)
  if (!fs.existsSync(dir)) return { ok: true, alreadyGone: true }
  if (options.keepRoot) return { ok: true, kept: true, dir }
  // 先删 junction，避免递归进入核心/缓存
  for (const rel of ['runtimes/windows-x64/node', 'runtimes/windows-x64/dsh', 'runtimes/windows-x64/bin', 'packages', 'runtimes', 'bin']) {
    removeJunction(path.join(run.root, rel))
  }
  for (const rel of ['data', 'scripts', 'temp', 'logs', 'state', '.sandbox-gate']) {
    rmrf(path.join(run.root, rel))
  }
  rmrf(run.root)
  rmrf(dir)
  return { ok: true, disposed: true, dir }
}

export function runLogPaths(paths, run) {
  const dir = paths.evidenceDir(run.runId)
  return {
    dir,
    boot: path.join(dir, 'boot.log'),
    install: path.join(dir, 'install.log'),
    report: path.join(dir, 'report.json'),
  }
}
