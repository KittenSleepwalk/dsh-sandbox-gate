import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import { ensureDir, readJson, writeJsonAtomic, writeTextAtomic, sha256File, sha256Text, hashTree, copyTree, junction, rmrf, exec, nowIso, runId } from './util.js'
import { sandboxNode, sandboxPnpmCli } from './config.js'

const ONLY_BUILT = [
  '@deepseek-ai/dsh-subprocess-local',
  'koffi',
  'node-pty',
  '@google/genai',
  'protobufjs',
  'esbuild',
]

export function fileUrl(p) {
  const normalized = path.resolve(p).replace(/\\/g, '/')
  const encoded = normalized
    .split('/')
    .map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join('/')
  return 'file:///' + encoded
}

export function pluginDirName(name) {
  return String(name).replace(/[^0-9A-Za-z._-]/g, '_')
}

/** 确保 gate 自己持有一份指定版本的 dsh 核心（不改 portable manifest）。 */
export function ensureCore(paths, config, version, log = () => {}) {
  const dir = paths.coreDir(version)
  const pkgFile = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  if (fs.existsSync(pkgFile) && readJson(pkgFile, {}).version === version) {
    return { ok: true, dir, cached: true }
  }
  ensureDir(dir)
  writeJsonAtomic(path.join(dir, 'package.json'), {
    name: 'sandbox-gate-core',
    private: true,
    dependencies: { '@deepseek-ai/dsh': version },
  })
  // autoInstallPeers 必须为 true：dsh-app-boot 等核心包把 @deepseek-ai/cordis-plugin-*
  // 声明成 peerDependency，关掉 peer 自动安装会得到一个跑不起来的核心
  // （实测 ERR_MODULE_NOT_FOUND: @deepseek-ai/cordis-plugin-group）。
  writeTextAtomic(
    path.join(dir, 'pnpm-workspace.yaml'),
    ['packages: []', 'nodeLinker: hoisted', 'autoInstallPeers: true', 'strictDepBuilds: false', 'onlyBuiltDependencies:', ...ONLY_BUILT.map((n) => `  - "${n}"`), ''].join('\n'),
  )
  const result = runPnpm(config, dir, ['install', '--prod', '--no-frozen-lockfile'], log, 30 * 60 * 1000)
  if (!result.ok) return { ok: false, dir, error: '核心安装失败', log: result }
  const installed = readJson(pkgFile, {}).version
  return { ok: installed === version, dir, version: installed, cached: false, log: result }
}

export function runPnpm(config, cwd, args, log, timeout = 30 * 60 * 1000) {
  const node = sandboxNode(config)
  const pnpm = sandboxPnpmCli(config)
  if (!fs.existsSync(node)) return { ok: false, error: `缺少沙盒 node：${node}` }
  if (!fs.existsSync(pnpm)) return { ok: false, error: `缺少沙盒 pnpm：${pnpm}` }
  log(`pnpm ${args.join(' ')} (cwd=${cwd})`)
  const result = exec(node, [pnpm, ...args], { cwd, timeout })
  if (!result.ok) log(`pnpm 失败：${(result.stderr || result.stdout || '').slice(-2000)}`)
  return result
}

/** 构建只读基线。force=true 时重建。 */
export function buildBaseline(paths, config, inventory, options = {}) {
  const log = options.log || (() => {})
  const version = inventory.host.coreVersion
  const force = Boolean(options.force)
  paths.ensureLayout()

  if (!force && fs.existsSync(paths.baselineManifest)) {
    const old = readJson(paths.baselineManifest)
    if (old && old.coreVersion === version && old.fingerprint) {
      return { ok: true, cached: true, manifest: old, dir: old.baselineRoot }
    }
  }

  const core = ensureCore(paths, config, version, log)
  if (!core.ok) return { ok: false, error: core.error || `核心 ${version} 安装失败`, detail: core }

  const id = runId('baseline')
  const tmp = paths.ensure(path.join(paths.gate, `baseline-tmp-${id}`))
  const root = path.join(tmp, 'root')
  try {
    buildSkeleton(paths, config, root, core.dir, log)
    const profileDir = path.join(root, 'data', 'dsh-home', 'profiles', config.baselineProfile)
    const profileResult = writeBaselineProfile(paths, config, inventory, profileDir, log)
    if (!profileResult.ok) throw new Error(profileResult.error)

    copySandboxSessionsAndStorage(paths, config, root, log)

    const install = runPnpm(config, profileDir, ['install', '--prod', '--no-frozen-lockfile'], log, 45 * 60 * 1000)
    if (!install.ok) throw new Error('基线 profile 依赖安装失败：' + (install.stderr || '').slice(-3000))

    // 校验每个 bundle 是否真实可解析；缺失则单独补装。
    const missing = []
    for (const bundle of profileResult.bundles) {
      if (!resolveFromProfile(profileDir, bundle, core.dir)) missing.push(bundle)
    }
    if (missing.length) {
      log(`缺失 bundle：${missing.join(', ')}，尝试单独补装`)
      for (const name of missing) {
        const spec = profileResult.specs[name]
        const arg = spec && spec !== name ? `${name}@${spec}` : name
        runPnpm(config, profileDir, ['add', arg, '--ignore-scripts'], log, 10 * 60 * 1000)
      }
    }
    const stillMissing = profileResult.bundles.filter((b) => !resolveFromProfile(profileDir, b, core.dir))

    const manifest = {
      version: 1,
      builtAt: nowIso(),
      coreVersion: version,
      coreDir: core.dir,
      sandboxRoot: config.sandboxRoot,
      baselineRoot: path.join(paths.baseline, 'root'),
      profile: config.baselineProfile,
      plugins: profileResult.installable,
      bundles: profileResult.bundles,
      specs: profileResult.specs,
      excluded: inventory.excluded,
      canary: profileResult.canary,
      sessions: profileResult.sessions,
      expectedEntries: null,
      missingBundles: stillMissing,
      warnings: profileResult.warnings,
      fingerprint: null,
    }
    manifest.fingerprint = baselineFingerprint(profileDir, manifest)
    if (stillMissing.length) {
      manifest.warnings.push(`以下 bundle 安装后仍不可解析：${stillMissing.join(', ')}`)
    }

    // 原子替换：旧 baseline 改名到同级目录后删除（不能放进自身内部）
    const finalRoot = paths.baseline
    const old = path.join(paths.gate, `baseline-old-${id}`)
    if (fs.existsSync(finalRoot)) fs.renameSync(finalRoot, old)
    fs.renameSync(tmp, finalRoot)
    rmrf(old)
    writeJsonAtomic(paths.baselineManifest, manifest)
    log(`基线完成：${manifest.baselineRoot}`)
    return { ok: true, cached: false, manifest, dir: manifest.baselineRoot }
  } catch (error) {
    rmrf(tmp)
    return { ok: false, error: String(error.message || error) }
  }
}

function buildSkeleton(paths, config, root, coreDir, log) {
  ensureDir(root)
  const nodeDir = path.join(config.sandboxRoot, 'runtimes', 'windows-x64', 'node')
  const binDir = path.join(config.sandboxRoot, 'runtimes', 'windows-x64', 'bin')
  const packagesDir = path.join(config.sandboxRoot, 'packages')
  junction(nodeDir, path.join(root, 'runtimes', 'windows-x64', 'node'))
  junction(coreDir, path.join(root, 'runtimes', 'windows-x64', 'dsh'))
  if (fs.existsSync(binDir)) junction(binDir, path.join(root, 'runtimes', 'windows-x64', 'bin'))
  if (fs.existsSync(packagesDir)) junction(packagesDir, path.join(root, 'packages'))
  const scripts = path.join(config.sandboxRoot, 'scripts')
  if (fs.existsSync(scripts)) copyTree(scripts, path.join(root, 'scripts'))
  for (const rel of ['data/agents-home', 'data/portable-home', 'temp', 'logs', 'data/dsh-home/profiles', 'data/dsh-home/storages']) {
    ensureDir(path.join(root, rel))
  }
  log('运行骨架完成（core/node/bin/packages 使用 junction）')
}

function writeBaselineProfile(paths, config, inventory, profileDir, log) {
  ensureDir(profileDir)
  // 从沙盒现有 profile 继承 pnpm 设置与 cordis.yml（不继承它的依赖）
  const srcProfile = path.join(config.sandboxRoot, 'data', 'dsh-home', 'profiles', config.baselineProfile)
  for (const name of ['cordis.yml', 'pnpm-workspace.yaml']) {
    const src = path.join(srcProfile, name)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(profileDir, name))
  }
  if (!fs.existsSync(path.join(profileDir, 'cordis.yml'))) writeTextAtomic(path.join(profileDir, 'cordis.yml'), '[]\n')

  const deps = {}
  const specs = {}
  const warnings = []
  const localPlugins = []
  const installable = []

  for (const dep of inventory.deps) {
    installable.push(dep.name)
    if (dep.kind === 'link' || dep.kind === 'file') {
      if (!dep.target || !fs.existsSync(dep.target)) {
        warnings.push({ name: dep.name, reason: 'local-target-missing', target: dep.target })
        installable.pop()
        continue
      }
      const dirName = pluginDirName(dep.name)
      const dest = path.join(profileDir, '.gate-plugins', dirName)
      copyTree(dep.target, dest, {
        filter: (from, entry) => !['node_modules', '.git', '.sandbox-gate'].includes(entry.name),
      })
      deps[dep.name] = `file:./.gate-plugins/${dirName}`
      specs[dep.name] = deps[dep.name]
      localPlugins.push({ name: dep.name, src: dep.target, dest })
      continue
    }
    if (dep.kind === 'github' || dep.kind === 'url') {
      // GitHub 可能不可达：优先复用主机已安装的那份，离线可用。
      const installed = path.join(config.hostProfileDir, 'node_modules', ...dep.name.split('/'))
      if (fs.existsSync(path.join(installed, 'package.json'))) {
        const dirName = pluginDirName(dep.name)
        const dest = path.join(profileDir, '.gate-plugins', dirName)
        copyTree(installed, dest, {
          filter: (from, entry) => !['node_modules', '.git', '.sandbox-gate'].includes(entry.name),
        })
        deps[dep.name] = `file:./.gate-plugins/${dirName}`
        specs[dep.name] = deps[dep.name]
        localPlugins.push({ name: dep.name, src: installed, dest, note: 'host-installed-copy' })
        warnings.push({ name: dep.name, reason: 'git-source-copied-from-host', spec: dep.spec })
        continue
      }
      deps[dep.name] = dep.spec
      specs[dep.name] = dep.spec
      continue
    }
    // registry：优先精确版本
    const spec = dep.spec && dep.spec !== '*' ? dep.spec : 'latest'
    deps[dep.name] = spec
    specs[dep.name] = spec
  }

  const bundles = inventory.bundles.filter((b) => installable.includes(b) || b.startsWith('@deepseek-ai/dsh-'))
  for (const base of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']) {
    if (!bundles.includes(base)) bundles.unshift(base)
  }

  const pkg = {
    name: 'sandbox-baseline-profile',
    private: true,
    type: 'module',
    dependencies: deps,
    dsh: { profile: { bundles } },
  }
  writeJsonAtomic(path.join(profileDir, 'package.json'), pkg)

  // pnpm 11：onlyBuiltDependencies 必须写在 workspace yaml
  const workspace = [
    'packages:',
    '  - .',
    'nodeLinker: hoisted',
    'autoInstallPeers: false',
    'strictDepBuilds: false',
    'onlyBuiltDependencies:',
    ...ONLY_BUILT.map((n) => `  - "${n}"`),
    '',
  ].join('\n')
  writeTextAtomic(path.join(profileDir, 'pnpm-workspace.yaml'), workspace)

  const canaryPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'canary', 'index.js')
  const canaryOut = '.sandbox-gate/canary-out'
  const canary = {
    id: 'sandbox-canary',
    path: fileUrl(canaryPath),
    outDir: canaryOut,
  }
  const patch = [
    '# 由 dsh-sandbox-gate 生成的基线 patch：只注入 canary，不继承主机 UI 配置。',
    '- insert:',
    '    - id: sandbox-canary',
    `      name: "${canary.path}"`,
    '      config:',
    `        outDir: "${canaryOut}"`,
    '',
  ].join('\n')
  writeTextAtomic(path.join(profileDir, 'cordis.patch.yml'), patch)

  // compatibility.json：能算就算，算不出留空数组，避免 loader 误判
  writeJsonAtomic(path.join(profileDir, 'compatibility.json'), {})

  log(`基线 profile：${installable.length} 个插件候选，${localPlugins.length} 个本地插件已复制`)
  return {
    ok: true,
    installable,
    bundles,
    specs,
    warnings,
    localPlugins,
    canary,
    sessions: { synced: false, reason: 'sandbox-already-has-session' },
  }
}

function resolveFromProfile(profileDir, name, coreDir) {
  if (fs.existsSync(path.join(profileDir, 'node_modules', name, 'package.json'))) return true
  // 核心自带的 bundle 从 pnpm 隔离布局解析：dsh 的真实路径兄弟目录里就是全部依赖。
  try {
    const realDsh = fs.realpathSync(path.join(coreDir, 'node_modules', '@deepseek-ai', 'dsh'))
    const coreNodeModules = path.dirname(path.dirname(realDsh))
    if (fs.existsSync(path.join(coreNodeModules, name, 'package.json'))) return true
  } catch {
    /* ignore */
  }
  return false
}

function copySandboxSessionsAndStorage(paths, config, root, log) {
  const dataSrc = path.join(config.sandboxRoot, 'data', 'dsh-home')
  for (const rel of ['sessions', 'storages']) {
    const src = path.join(dataSrc, rel)
    if (fs.existsSync(src)) {
      copyTree(src, path.join(root, 'data', 'dsh-home', rel))
      log(`复制沙盒 ${rel}`)
    }
  }
}

export function baselineFingerprint(profileDir, manifest) {
  const parts = []
  for (const name of ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'compatibility.json']) {
    const file = path.join(profileDir, name)
    if (fs.existsSync(file)) parts.push(name + ':' + sha256File(file))
  }
  const gatePlugins = path.join(profileDir, '.gate-plugins')
  if (fs.existsSync(gatePlugins)) parts.push('local:' + hashTree(gatePlugins, { skip: ['node_modules'] }))
  parts.push('core:' + (manifest.coreVersion || ''))
  return 'sha256:' + sha256Text(parts.join('|'))
}

export function verifyBaseline(paths) {
  if (!fs.existsSync(paths.baselineManifest)) return { ok: false, error: '基线未构建' }
  const manifest = readJson(paths.baselineManifest)
  if (!manifest || !manifest.baselineRoot) return { ok: false, error: '基线 manifest 损坏' }
  const profileDir = path.join(manifest.baselineRoot, 'data', 'dsh-home', 'profiles', manifest.profile)
  const fp = baselineFingerprint(profileDir, manifest)
  return { ok: fp === manifest.fingerprint, expected: manifest.fingerprint, actual: fp, manifest }
}
