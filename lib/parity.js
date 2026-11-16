/**
 * 环境对齐：主机插件清单 ↔ 沙盒 live profile。
 *
 * 规则（用户约束）：
 * - 沙盒 live profile 必须包含主机所有可安装插件，**除 sand盒插件自身**；
 * - 可以多，不可以少；
 * - 缺插件时优先用 link: 指向主机已安装目录，避免重新下载/复制；
 * - 不修改主机任何文件（只读主机路径）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { readJson, writeJsonAtomic, nowIso, exec, ensureDir } from './util.js'
import { cachedInventory, calibrate } from './host.js'
import { sandboxNode, sandboxPnpmCli } from './config.js'

export const GATE_PACKAGE = '@kittensleepwalk/dsh-sandbox-gate'

export function liveProfileDir(config) {
  return path.join(config.sandboxRoot, 'data', 'dsh-home', 'profiles', config.baselineProfile)
}

export function readLiveProfile(config) {
  const dir = liveProfileDir(config)
  const pkgPath = path.join(dir, 'package.json')
  const pkg = readJson(pkgPath, null)
  if (!pkg) throw new Error(`沙盒 live profile 不存在：${pkgPath}`)
  return { dir, pkgPath, pkg }
}

function hostNodeModules(config, name) {
  return path.join(config.hostProfileDir, 'node_modules', ...name.split('/'))
}

/** 读取 node_modules/<key>/package.json 的实际包名；alias 安装时 key 与包名可能不同。 */
function installedName(profileDir, key) {
  const pkg = path.join(profileDir, 'node_modules', ...String(key).split('/'), 'package.json')
  try {
    const json = readJson(pkg, null)
    return json && json.name ? json.name : key
  } catch {
    return key
  }
}

function toPosix(p) {
  return String(p).replace(/\\/g, '/')
}

/** 只读比对：主机可安装插件 vs 沙盒 live profile。 */
export function parityReport(paths, config, inventory) {
  const inv = inventory || cachedInventory(paths, config).inventory || calibrate(paths, config)
  const hostDeps = (inv.deps || []).filter((d) => d.name !== GATE_PACKAGE)
  const live = readLiveProfile(config)
  const liveDeps = live.pkg.dependencies || {}
  const liveKeys = new Set(Object.keys(liveDeps))
  const liveNames = new Set()
  for (const key of liveKeys) liveNames.add(installedName(live.dir, key))
  const hostKeys = new Set()
  const hostNames = new Set()
  for (const dep of hostDeps) {
    hostKeys.add(dep.name)
    hostNames.add(installedName(config.hostProfileDir, dep.name))
  }
  const missing = hostDeps
    .filter((d) => {
      const actual = installedName(config.hostProfileDir, d.name)
      return !liveKeys.has(d.name) && !liveNames.has(actual)
    })
    .map((d) => ({ name: d.name, spec: d.spec, kind: d.kind }))
  const extra = [...liveKeys].filter((k) => !hostKeys.has(k) && !hostNames.has(installedName(live.dir, k)) && k !== GATE_PACKAGE)
  return {
    at: nowIso(),
    hostCount: hostDeps.length,
    liveCount: liveNames.size,
    missing,
    extra,
    gateInstalled: liveNames.has(GATE_PACKAGE),
    canaryInjected: /sandbox-canary/.test(String(readPatch(live.dir))),
    ok: missing.length === 0 && !liveNames.has(GATE_PACKAGE),
  }
}

function readPatch(profileDir) {
  const p = path.join(profileDir, 'cordis.patch.yml')
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
}

/** 从 cordis.patch.yml 移除 sandbox-canary 的 insert 块（保留其他 patch）。 */
export function stripCanary(patchText) {
  const lines = String(patchText || '').split(/\r?\n/)
  const out = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s*-\s*insert:\s*$/.test(line)) {
      // 向后看到该 insert 块结束；块内出现 sandbox-canary 才删除
      let end = i + 1
      while (end < lines.length && /^\s{2,}/.test(lines[end])) end += 1
      const block = lines.slice(i, end).join('\n')
      if (/sandbox-canary/.test(block)) {
        i = end - 1
        // 顺手吞掉紧邻上方的注释行
        while (out.length && /^\s*#\s*sandbox-gate canary/.test(out[out.length - 1])) out.pop()
        continue
      }
    }
    out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

function resolveLiveSpec(config, dep) {
  if (dep.kind === 'link' || dep.kind === 'file') {
    const target = dep.target || hostNodeModules(config, dep.name)
    if (target && fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      return `link:${toPosix(fs.realpathSync(target))}`
    }
    if (dep.kind === 'file') return dep.spec
  }
  if (dep.kind === 'github' || dep.kind === 'url') {
    const installed = hostNodeModules(config, dep.name)
    if (fs.existsSync(installed)) return `link:${toPosix(fs.realpathSync(installed))}`
  }
  return dep.spec
}

/**
 * 补齐 live profile。
 * - 默认删除沙盒插件自身（用户要求沙盒列表里不出现 sandbox 插件）；
 * - 缺插件用 link: 指向主机已安装目录，registry 插件按主机版本 spec 安装；
 * - dryRun 只返回计划，不写文件、不跑 pnpm。
 */
export function syncLiveProfile(paths, config, options = {}) {
  const log = options.log || (() => {})
  const inventory = options.inventory || cachedInventory(paths, config).inventory || calibrate(paths, config)
  const report = parityReport(paths, config, inventory)
  const live = readLiveProfile(config)
  const pkg = JSON.parse(JSON.stringify(live.pkg))
  pkg.dependencies = pkg.dependencies || {}
  const additions = []
  for (const item of report.missing) {
    const dep = (inventory.deps || []).find((d) => d.name === item.name)
    if (!dep) continue
    const spec = resolveLiveSpec(config, dep)
    if (!spec) continue
    pkg.dependencies[dep.name] = spec
    additions.push({ name: dep.name, spec })
  }
  const removed = []
  if (pkg.dependencies[GATE_PACKAGE]) {
    delete pkg.dependencies[GATE_PACKAGE]
    removed.push(GATE_PACKAGE)
  }
  const bundles = (((pkg.dsh || {}).profile || {}).bundles || []).filter((b) => b !== GATE_PACKAGE)
  const originalBundles = new Set(bundles)
  const hostBundles = inventory.bundles || []
  const bundleSet = new Set(bundles)
  for (const b of hostBundles) {
    if (b === GATE_PACKAGE) continue
    const dep = (inventory.deps || []).find((d) => d.name === b)
    if (dep && pkg.dependencies[b]) bundleSet.add(b)
  }
  pkg.dsh = pkg.dsh || {}
  pkg.dsh.profile = pkg.dsh.profile || {}
  pkg.dsh.profile.bundles = [...bundleSet]

  const patchPath = path.join(live.dir, 'cordis.patch.yml')
  const patchBefore = readPatch(live.dir)
  const patchAfter = stripCanary(patchBefore)
  const plan = {
    additions,
    removed,
    bundlesAdded: [...bundleSet].filter((b) => !originalBundles.has(b)),
    canaryRemoved: patchBefore !== patchAfter,
  }
  if (options.dryRun) return { ok: report.ok && !plan.canaryRemoved && additions.length === 0, dryRun: true, plan, parity: report }

  ensureDir(live.dir)
  writeJsonAtomic(live.pkgPath, pkg)
  if (patchBefore !== patchAfter) fs.writeFileSync(patchPath, patchAfter, 'utf8')

  if (additions.length || removed.length) {
    const args = ['install', '--prod', '--no-frozen-lockfile']
    log(`[parity] pnpm ${args.join(' ')} @ ${live.dir}`)
    const result = exec(sandboxNode(config), [sandboxPnpmCli(config), ...args], {
      cwd: live.dir,
      timeout: 600000,
      env: { ...process.env, DSH_PORTABLE_NO_AUTO_UPDATE: '1' },
    })
    if (result.code !== 0) {
      return { ok: false, error: 'pnpm install 失败', detail: String(result.stderr || result.stdout).slice(-4000), plan, parity: report }
    }
  }
  const after = parityReport(paths, config, inventory)
  const out = { ok: after.ok && additions.length >= 0, at: nowIso(), plan, parity: after, profile: live.dir }
  writeJsonAtomic(paths.parityFile, out)
  return out
}
