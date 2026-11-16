import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureDir, writeJsonAtomic, writeTextAtomic, nowIso, rmrf, exec, copyTree } from './util.js'
import { sandboxNode } from './config.js'
import { fileUrl } from './baseline.js'
import { launchDsh, waitForBoot, waitForCanary, readCanary, pickPort, stopDsh } from './launch.js'

function liveProfileDir(config) {
  return path.join(config.sandboxRoot, 'data', 'dsh-home', 'profiles', config.baselineProfile)
}

function installedPackageDir(profileDir, packageName) {
  return path.join(profileDir, 'node_modules', ...packageName.split('/'))
}

function readPackage(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

export function liveCanaryPatch(paths, config, runId) {
  const outDir = path.join(config.sandboxRoot, '.sandbox-gate', 'canary-out')
  const indexPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'canary', 'index.js')
  const file = path.join(paths.gate, 'state', `live-canary-${runId}.yml`)
  const body = [
    '- insert:',
    `    - id: sandbox-canary-live`,
    `      name: "${fileUrl(indexPath)}"`,
    '      config:',
    `        outDir: "${outDir.replace(/\\/g, '/')}"`,
    '',
  ].join('\n')
  writeTextAtomic(file, body)
  return { file, outDir, indexPath }
}

/** 把候选装进 live 沙盒 profile（保留），失败时回滚安装。 */
export async function installIntoLive(paths, config, options = {}) {
  const log = options.log || (() => {})
  const packageName = options.packageName
  const source = options.source
  if (!packageName || !source) return { ok: false, detail: '缺少包名或候选源码目录' }
  const profileDir = liveProfileDir(config)
  if (!fs.existsSync(path.join(profileDir, 'package.json'))) return { ok: false, detail: `live profile 不存在：${profileDir}` }

  // 候选必须复制进沙盒自己的目录，不能把 live profile 链回拟主机/工作区。
  const dest = path.join(config.sandboxRoot, 'candidates', packageName.replace(/[\\/]/g, '__'))
  try {
    const realSource = fs.realpathSync(source)
    const realDest = fs.existsSync(dest) ? fs.realpathSync(dest) : dest
    if (realSource !== realDest) {
      rmrf(dest)
      ensureDir(path.dirname(dest))
      copyTree(source, dest)
      log(`候选已复制进沙盒：${dest}`)
    }
  } catch (error) {
    return { ok: false, detail: `候选复制失败：${String(error.message || error)}` }
  }

  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)
  const backupDir = paths.ensure(path.join(paths.state, `live-backup-${stamp}`))
  fs.copyFileSync(path.join(profileDir, 'package.json'), path.join(backupDir, 'package.json'))
  if (fs.existsSync(path.join(profileDir, 'cordis.patch.yml'))) {
    fs.copyFileSync(path.join(profileDir, 'cordis.patch.yml'), path.join(backupDir, 'cordis.patch.yml'))
  }

  // 沙盒里跑的 DSH 同样会加载 dsh-undo-savepoint：它探测到“上次启动没走完”时会写
  // SAFE MODE 补丁（禁用除自己外的所有用户插件），或把 patch 文件清成空文件。
  // 这会让 T16 看到“候选没出现”这种假失败——启动前把这类污染还原成干净补丁层。
  const patchPath = path.join(profileDir, 'cordis.patch.yml')
  if (fs.existsSync(patchPath)) {
    const rawPatch = fs.readFileSync(patchPath, 'utf8')
    const bodyOf = (text) => text.split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join('\n').trim()
    const body = bodyOf(rawPatch)
    const safeMode = /SAFE MODE/i.test(rawPatch)
    if (body.length === 0 || safeMode) {
      const backupPatchPath = path.join(backupDir, 'cordis.patch.yml')
      const backupRaw = fs.existsSync(backupPatchPath) ? fs.readFileSync(backupPatchPath, 'utf8') : ''
      const backupBody = bodyOf(backupRaw)
      const usableBackup = backupBody.length > 0 && !/SAFE MODE/i.test(backupRaw)
      const replacement = usableBackup
        ? backupRaw
        : [
            '# Your patch layer for this dsh profile, applied after every bundle layer:',
            '# a top-level YAML array of loader patch entries.',
            '[]',
            '',
          ].join('\n')
      writeTextAtomic(patchPath, replacement)
      log(`live 补丁层被污染（${body.length === 0 ? '空文件' : 'SAFE MODE'}），已还原为可用补丁层`)
    }
  }

  // 必须装成“真拷贝”，不能用 `pnpm add <目录>`：目录依赖会被装成 link:（指向
  // candidates/），DSH 启动时会把这种 bundle 静默丢弃——canary 里既看不到该 entry，
  // 也不报 failed，T16 只会看到“候选未出现”。所以先 npm pack 成 tarball 再装。
  // 打包产物必须留在沙盒里：profile 依赖会记成 file:<tgz>，装完就删会让 live profile
  // 指向不存在的文件，之后 pnpm install 直接失败，boot 也可能起不来。
  const packDir = paths.ensure(path.join(paths.state, 'packs', `live-${stamp}`), { mustBeGate: true })
  const npmCli = path.join(config.sandboxRoot, 'runtimes', 'windows-x64', 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const packed = exec(sandboxNode(config), [npmCli, 'pack', '--ignore-scripts', '--pack-destination', packDir], {
    cwd: dest,
    env: { ...process.env, NO_COLOR: '1' },
    timeout: 5 * 60 * 1000,
  })
  if (!packed.ok) {
    return { ok: false, detail: `候选打包失败（npm pack exit=${packed.code}）：${(packed.stderr || packed.stdout || '').slice(-1000)}`, backupDir }
  }
  const tgzName = fs.readdirSync(packDir).find((f) => f.endsWith('.tgz'))
  if (!tgzName) {
    return { ok: false, detail: 'npm pack 未产出 .tgz', backupDir }
  }
  // 装进沙盒统一走 dshsandbox（独立脚本，绝对路径调用，绝不碰主机 home），
  // 不在这里直接拼 pnpm 参数，也不再和 `dsh`（主机）命令混用。
  const sandboxCli = path.join(config.sandboxRoot, 'bin', 'dshsandbox.mjs')
  if (!fs.existsSync(sandboxCli)) {
    return { ok: false, detail: `沙盒缺少 dshsandbox 脚本：${sandboxCli}（应从插件 bin/dshsandbox.mjs 复制一份过去）`, backupDir }
  }
  const installResult = exec(
    sandboxNode(config),
    [sandboxCli, 'entity', path.join(packDir, tgzName), '--profile', config.baselineProfile, '--root', config.sandboxRoot],
    { cwd: config.sandboxRoot, env: { ...process.env, NO_COLOR: '1' }, timeout: 10 * 60 * 1000 },
  )
  const install = { ok: installResult.ok, stdout: installResult.stdout, stderr: installResult.stderr }
  if (!install.ok) {
    return { ok: false, detail: `live 安装失败：${(install.stderr || install.stdout || '').slice(-1000)}`, backupDir }
  }
  const pkg = readPackage(installedPackageDir(profileDir, packageName))
  if (!pkg) {
    return { ok: false, detail: `live 安装后找不到 ${packageName}`, backupDir }
  }

  let bundleAdded = false
  if (pkg.dsh?.bundle?.patch) {
    const profilePkgPath = path.join(profileDir, 'package.json')
    const profilePkg = JSON.parse(fs.readFileSync(profilePkgPath, 'utf8'))
    const bundles = Array.isArray(profilePkg.dsh?.profile?.bundles) ? profilePkg.dsh.profile.bundles : []
    if (!bundles.includes(packageName)) {
      profilePkg.dsh = profilePkg.dsh || {}
      profilePkg.dsh.profile = profilePkg.dsh.profile || {}
      profilePkg.dsh.profile.bundles = [...bundles, packageName]
      writeJsonAtomic(profilePkgPath, profilePkg)
      bundleAdded = true
    }
  }
  return { ok: true, profileDir, packageName, version: pkg.version, bundleAdded, backupDir }
}

export async function rollbackLiveInstall(paths, config, info) {
  if (!info?.ok) return { ok: true, skipped: true }
  const profileDir = info.profileDir
  const log = () => {}
  const sandboxCli = path.join(config.sandboxRoot, 'bin', 'dshsandbox.mjs')
  try {
    if (fs.existsSync(sandboxCli)) {
      exec(
        sandboxNode(config),
        [sandboxCli, 'remove', info.packageName, '--profile', config.baselineProfile, '--root', config.sandboxRoot],
        { cwd: config.sandboxRoot, env: { ...process.env, NO_COLOR: '1' }, timeout: 5 * 60 * 1000 },
      )
    }
  } catch {
    /* ignore */
  }
  if (info.backupDir) {
    const pkgBackup = path.join(info.backupDir, 'package.json')
    if (fs.existsSync(pkgBackup)) fs.copyFileSync(pkgBackup, path.join(profileDir, 'package.json'))
    const patchBackup = path.join(info.backupDir, 'cordis.patch.yml')
    if (fs.existsSync(patchBackup)) fs.copyFileSync(patchBackup, path.join(profileDir, 'cordis.patch.yml'))
  }
  return { ok: true }
}

/** 启动 live 沙盒并确认候选 entry active；不写 profile patch（用 --patch 临时注入 canary）。 */
export async function verifyLiveBoot(paths, config, options = {}) {
  const log = options.log || (() => {})
  const packageName = options.packageName
  const runId = options.runId || 'live'
  const canary = liveCanaryPatch(paths, config, runId)
  const statusFile = path.join(canary.outDir, 'status.json')
  try {
    rmrf(statusFile)
  } catch {
    /* ignore */
  }
  const port = await pickPort(config)
  const pseudo = {
    root: config.sandboxRoot,
    profile: config.baselineProfile,
    port,
    extraArgs: ['--patch', canary.file],
  }
  const handle = launchDsh(pseudo, config, null)
  let status = null
  try {
    const boot = await waitForBoot(handle, config.bootTimeoutSec || 90)
    if (!boot.ok) {
      return { ok: false, detail: `live 启动失败：${boot.reason || ''} ${boot.exitCode ?? ''}`.trim(), bootLog: handle.bootLog }
    }
    const seen = await waitForCanary(pseudo, 45, false)
    if (!seen.ok) return { ok: false, detail: 'live 启动后 canary 未产出 status.json', bootLog: handle.bootLog }
    status = readCanary(pseudo) || seen.status
    const deadline = Date.now() + 30000
    let wanted = null
    while (Date.now() < deadline) {
      const rows = Array.isArray(status.rows) ? status.rows : []
      wanted = rows.find((r) => !r.isGroup && (r.name === packageName || String(r.name || '').includes(packageName)))
      const failed = (status.failed || []).filter((r) => r.name !== 'sandbox-canary-live')
      if (wanted && (wanted.state === 2 || failed.length) && failed.length === 0) break
      await new Promise((resolve) => setTimeout(resolve, 1000))
      status = readCanary(pseudo) || status
    }
    const rows = Array.isArray(status.rows) ? status.rows : []
    wanted = rows.find((r) => !r.isGroup && (r.name === packageName || String(r.name || '').includes(packageName)))
    if (!wanted) {
      return { ok: false, detail: `候选 ${packageName} 未出现在 live canary`, canary: status, bootLog: handle.bootLog }
    }
    if (wanted.state !== 2) {
      return { ok: false, detail: `候选 ${packageName} 状态 ${wanted.phase}（非 active）`, canary: status, bootLog: handle.bootLog }
    }
    const failed = (status.failed || []).filter((r) => r.name !== 'sandbox-canary-live')
    if (failed.length) {
      return { ok: false, detail: `live 沙盒有 ${failed.length} 个 entry failed：${failed.map((r) => r.name).join(', ')}`, canary: status, bootLog: handle.bootLog }
    }
    return { ok: true, port: boot.port, url: boot.url, canary: status, bootLog: handle.bootLog }
  } finally {
    await stopDsh(handle)
    try {
      fs.unlinkSync(canary.file)
    } catch {
      /* ignore */
    }
  }
}

export function runFunctionalCommand(command, cwd, timeoutMs = 120000) {
  if (!command) return { ok: true, skipped: true, detail: '未提供功能检查命令' }
  const result = exec('cmd.exe', ['/d', '/s', '/c', 'call', command], { cwd, timeout: timeoutMs })
  return {
    ok: result.ok,
    detail: result.ok
      ? `功能检查通过：${String(result.stdout || '').trim().slice(-500)}`
      : `功能检查失败（exit ${result.code}）：${String(result.stderr || result.stdout || result.error || '').trim().slice(-500)}`,
    output: String(result.stdout || result.stderr || '').slice(-2000),
  }
}
