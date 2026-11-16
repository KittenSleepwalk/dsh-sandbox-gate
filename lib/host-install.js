import fs from 'node:fs'
import path from 'node:path'
import { sandboxNode, sandboxPnpmCli } from './config.js'
import { auditCandidate } from './audit.js'
import { findReceipt, appendHostInstall, readHostInstalls } from './state.js'
import { exec, sha256File, nowIso, ensureDir, runId } from './util.js'

/**
 * 主机安装：唯一允许写主机 profile 的路径。
 *
 * 前置条件（缺一不可）：
 *  1. 对应包/版本存在 install_test 产生的 verdict=pass 凭证；
 *  2. 本次安装 spec 与凭证一致（path 候选还要 contentHash 一致，防止测完又改）；
 *  3. 调用方显式传入 confirm，且值等于包名（给用户/agent 一次明确确认的机会）。
 *
 * 本函数不重启主机 DSH；安装完成后返回 needsRestart=true。
 *
 * Electron 管理的 desktop profile（DSH 0.2.2+）会拒绝 dsh CLI 写入：此时本函数不硬来，
 * 返回 installMode='handoff' + handoff.target，由 Electron 的 plugin_manager 落盘
 * （spec 候选交 name@version；path 候选交 .dsh/plugin-archives 里的 tarball）。
 */

/**
 * Electron 桌面版独占的 profile：dsh CLI 一律拒绝写入（managed exclusively），
 * 落盘只能交回 App 自己的 plugin_manager。在调 CLI 之前就判断，别去敲错的门。
 */
function isElectronOwnedProfile(profileDir) {
  return (
    fs.existsSync(path.join(profileDir, '.harness.pid')) ||
    fs.existsSync(path.join(profileDir, '.plugin-manager'))
  )
}

function readHostProfile(config) {
  const file = path.join(config.hostProfileDir, 'package.json')
  return { file, pkg: JSON.parse(fs.readFileSync(file, 'utf8')) }
}

export function previewHostInstall(paths, config, args = {}) {
  if (!args.path && !args.spec) return { ok: false, error: '需要 path 或 spec' }
  const audit = auditCandidate(paths, config, { path: args.path, spec: args.spec })
  if (!audit.dir) return { ok: false, error: '无法解析候选包目录', findings: audit.findings }
  const receipt = findReceipt(paths, { packageName: audit.name, version: audit.version })
  const hashOk = !args.path || !receipt?.contentHash || receipt.contentHash === audit.contentHash
  return {
    ok: Boolean(receipt && hashOk),
    packageName: audit.name,
    version: audit.version,
    contentHash: audit.contentHash,
    auditVerdict: audit.verdict,
    hasReceipt: Boolean(receipt),
    receipt: receipt
      ? { runId: receipt.runId, verdict: receipt.verdict, version: receipt.version, at: receipt.recordedAt }
      : null,
    contentUnchanged: hashOk,
    needsConfirm: audit.name,
    error: !receipt
      ? '没有 verdict=pass 凭证：先调用 sandbox_gate_install_test'
      : !hashOk
        ? '候选内容在测试后发生变化：必须重新 install_test'
        : null,
  }
}

export function hostInstall(paths, config, args = {}) {
  const preview = previewHostInstall(paths, config, args)
  if (!preview.ok) return { ok: false, ...preview }
  if (args.confirm !== preview.packageName) {
    return {
      ok: false,
      error: `必须确认安装：confirm 应等于包名 ${preview.packageName}（当前：${args.confirm ?? '未提供'}）`,
      preview,
    }
  }

  const { file: profileFile, pkg: beforePkg } = readHostProfile(config)
  const beforeHash = sha256File(profileFile)

  // 用户要求“完整安装，不用 link 安装”：本地目录先用 pnpm pack 打成 tarball，
  // 再把 tarball 装进主机 profile。tarball 会复制到主机 .dsh/plugin-archives 留档，
  // 这样 node_modules 里是真实包内容，删掉候选源码目录也不影响已安装插件。
  let spec
  let tarball = null
  if (args.path) {
    const src = path.resolve(args.path)
    const tmp = path.join(paths.gate, 'tmp', `pack-${runId()}`)
    ensureDir(tmp)
    const packed = exec(sandboxNode(config), [sandboxPnpmCli(config), 'pack', '--pack-destination', tmp], {
      cwd: src,
      env: { ...process.env, NO_COLOR: '1' },
      timeout: 5 * 60 * 1000,
    })
    if (!packed.ok) {
      return { ok: false, error: `pnpm pack 失败（exit=${packed.code}）：${packed.stderr.slice(-2000)}` }
    }
    const name = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'))
    if (!name) return { ok: false, error: 'pnpm pack 未产出 .tgz' }
    const archiveDir = path.join(config.hostDshHome, 'plugin-archives')
    ensureDir(archiveDir)
    tarball = path.join(archiveDir, name)
    fs.copyFileSync(path.join(tmp, name), tarball)
    // 存档旁写一份元数据：Electron 的 plugin_manager 只能拿到 tarball 路径，
    // 守卫据此把路径还原成“包名+版本+内容哈希”，与 install_test 凭证对上。
    fs.writeFileSync(
      `${tarball}.json`,
      JSON.stringify(
        {
          packageName: preview.packageName,
          version: preview.version,
          contentHash: preview.contentHash,
          sha256: sha256File(tarball),
          receiptRunId: preview.receipt?.runId,
          recordedAt: nowIso(),
        },
        null,
        2,
      ),
    )
    spec = tarball
  } else {
    spec = String(args.spec)
  }

  const coreVersion =
    config.coreVersion ||
    fs.existsSync(paths.hostInventory) && JSON.parse(fs.readFileSync(paths.hostInventory, 'utf8'))?.host?.coreVersion ||
    fs.existsSync(paths.baselineManifest) && JSON.parse(fs.readFileSync(paths.baselineManifest, 'utf8'))?.coreVersion
  if (!coreVersion) return { ok: false, error: '无法确定主机核心版本：先运行 sandbox_gate_calibrate' }
  const dshBin = path.join(
    paths.coreDir(coreVersion),
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'lib',
    'bin.js',
  )
  if (!fs.existsSync(dshBin)) {
    return { ok: false, error: `沙盒核心 ${coreVersion} 未安装，无法调用 dsh CLI：${dshBin}` }
  }

  const env = {
    ...process.env,
    DSH_HOME: config.hostDshHome,
    DSH_PORTABLE_NO_AUTO_UPDATE: '1',
    NO_COLOR: '1',
  }
  ensureDir(paths.logs)
  const logPath = path.join(paths.logs, `host-install-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)

  // 交接给 Electron 的 plugin_manager：CLI 写不了这个 profile，别硬敲。
  //   - spec 候选：交 name@version，守卫按包名+版本查 pass 凭证；
  //   - path 候选：交 .dsh/plugin-archives 里的 tarball，守卫读同名 .json 元数据
  //     还原出包名/版本/内容哈希，再对上凭证。
  const buildHandoff = (reasonText, stderrTail = '') => {
    fs.writeFileSync(logPath, `[handoff] ${reasonText}\n${stderrTail}`.trimEnd() + '\n', 'utf8')
    const handoffTarget = tarball || String(args.spec)
    const handoffEntry = {
      packageName: preview.packageName,
      version: preview.version,
      spec,
      tarball,
      confirm: args.confirm,
      ok: false,
      status: 'handoff',
      exitCode: null,
      beforeHash,
      afterHash: beforeHash,
      installedSpec: null,
      logPath,
      needsRestart: false,
      receiptRun: preview.receipt?.runId || null,
      handoffTarget,
      startedAt: nowIso(),
    }
    appendHostInstall(paths, handoffEntry)
    return {
      ok: true,
      installed: false,
      prepared: true,
      packageName: preview.packageName,
      version: preview.version,
      installMode: 'handoff',
      installTarget: handoffTarget,
      handoff: {
        tool: 'plugin_manager',
        action: 'install_bundle',
        target: handoffTarget,
      },
      profileChanged: false,
      needsRestart: false,
      reason: reasonText,
      nextStep: `调用 plugin_manager { action: "install_bundle", target: "${handoffTarget}" } 完成落盘；守卫按 ${preview.packageName}@${preview.version} 的 pass 凭证放行，装完由用户重启 DSH`,
      logPath,
      stderrTail,
      receipt: preview.receipt,
    }
  }

  // 先判断再敲门：Electron 独占的 profile 直接交接，不产生那次注定失败的 CLI 调用。
  if (isElectronOwnedProfile(config.hostProfileDir)) {
    return buildHandoff(
      'desktop profile 由 Electron 应用独占（检出 .harness.pid / .plugin-manager），未调用 dsh CLI',
    )
  }

  const result = exec(
    sandboxNode(config),
    [dshBin, 'plugin', '--profile', 'desktop', 'add', spec],
    { cwd: config.hostDshHome, env, timeout: 15 * 60 * 1000 },
  )
  fs.writeFileSync(logPath, `${result.stdout}\n${result.stderr}`, 'utf8')

  // 兜底：CLI 自己也可能报这个错（例如 profile 刚被 App 接管），同样转交接。
  if (/managed exclusively by the Electron application/i.test(`${result.stdout}\n${result.stderr}`)) {
    return buildHandoff(
      'desktop profile 由 Electron 应用独占，dsh CLI 拒绝写入（managed exclusively by the Electron application）',
      result.stderr.slice(-2000),
    )
  }

  const afterHash = sha256File(profileFile)
  let afterPkg = null
  try {
    afterPkg = JSON.parse(fs.readFileSync(profileFile, 'utf8'))
  } catch {
    /* ignore */
  }
  const deps = afterPkg ? { ...(afterPkg.dependencies || {}), ...(afterPkg.devDependencies || {}) } : {}
  const installedSpec = deps[preview.packageName] || null
  const isLink = Boolean(installedSpec && String(installedSpec).startsWith('link:'))
  const ok = result.ok && !isLink

  const entry = {
    packageName: preview.packageName,
    version: preview.version,
    spec,
    tarball,
    confirm: args.confirm,
    ok,
    exitCode: result.code,
    beforeHash,
    afterHash,
    installedSpec,
    logPath,
    needsRestart: ok,
    receiptRun: preview.receipt?.runId || null,
    startedAt: nowIso(),
  }
  appendHostInstall(paths, entry)

  return {
    ok,
    installed: ok,
    packageName: preview.packageName,
    version: preview.version,
    installedSpec,
    installMode: isLink ? 'link' : tarball ? 'tarball' : 'spec',
    tarball,
    profileChanged: beforeHash !== afterHash,
    needsRestart: ok,
    restartHint: ok
      ? '主机 DSH 需要重启后才会加载新插件；本工具不会重启主机。重启前请让用户确认。'
      : null,
    logPath,
    exitCode: result.code,
    error: isLink ? `安装结果是 link（${installedSpec}），不符合“完整安装”要求` : null,
    stderrTail: result.stderr.slice(-4000),
    receipt: preview.receipt,
  }
}

export function listHostInstalls(paths) {
  return readHostInstalls(paths)
}
