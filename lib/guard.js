import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readJson } from './util.js'
import { GatePaths } from './paths.js'
import { readReceipts } from './state.js'

/**
 * 主机安装守卫。
 *
 * 目标不是“劝 agent 先测试”，而是让 agent 在工具层无法绕过：
 * 只要它通过 shell 执行 `dsh plugin add` / 在主机 profile 里 `pnpm add`，
 * 或调用 plugin_manager 的 install_bundle，都会被 tools.guard 拦下，
 * 除非对应包/版本已有 install_test 产生的 verdict=pass 凭证。
 *
 * 仍然存在的旁路：用户手动在外部终端执行、或绕过 DSH 工具层直接改 profile。
 * 这两种不属于“agent 会话安装”，由用户自己负责。
 */

const SHELL_TOOLS = new Set(['pwsh', 'bash', 'terminal', 'shell', 'cmd', 'powershell'])
const GATE_PACKAGE = '@kittensleepwalk/dsh-sandbox-gate'
const HOST_PROFILE = 'desktop'

function normSlashes(value) {
  return String(value || '').replace(/\\/g, '/')
}

function unquote(token) {
  return String(token || '').replace(/^["']|["']$/g, '')
}

/** 从 `name@version`、`file:...`、路径里解析包名/版本/目录。 */
export function resolveSpec(spec, baseDir) {
  const raw = unquote(String(spec || '').trim())
  if (!raw) return { raw, packageName: undefined }

  const withoutProtocol = raw.replace(/^file:/, '')
  const looksLikePath =
    /^[A-Za-z]:[\\/]/.test(withoutProtocol) ||
    withoutProtocol.startsWith('/') ||
    withoutProtocol.startsWith('./') ||
    withoutProtocol.startsWith('../')

  if (looksLikePath) {
    const dir = path.resolve(baseDir || process.cwd(), withoutProtocol)
    // Electron 的 plugin_manager 安装本地包时只传 tarball 路径；tarball 旁
    // 有 host-install 生成的元数据，可还原成包名/版本/内容哈希。
    if (/\.(?:tgz|tar\.gz)$/i.test(dir)) {
      const meta = readJson(`${dir}.json`)
      return {
        raw,
        dir,
        packageName: meta?.packageName,
        version: meta?.version,
        contentHash: meta?.contentHash,
        isPath: true,
        isTarball: true,
      }
    }
    const pkg = readJson(path.join(dir, 'package.json'))
    return {
      raw,
      dir,
      packageName: pkg?.name,
      version: pkg?.version,
      isPath: true,
    }
  }

  if (raw.startsWith('github:') || /^https?:/.test(raw)) {
    return {
      raw,
      packageName: raw.startsWith('github:') ? raw.slice('github:'.length).split('#')[0] : undefined,
      version: undefined,
      isRemote: true,
    }
  }

  const at = raw.lastIndexOf('@')
  if (raw.startsWith('@')) {
    // @scope/name 或 @scope/name@version
    const slash = raw.indexOf('/')
    if (at > slash) {
      return { raw, packageName: raw.slice(0, at), version: raw.slice(at + 1) }
    }
    return { raw, packageName: raw }
  }
  if (at > 0) return { raw, packageName: raw.slice(0, at), version: raw.slice(at + 1) }
  return { raw, packageName: raw }
}

/** 从一段 shell 命令里识别“主机桌面 profile 安装”。 */
export function parseInstallCommand(command, args = {}, config = {}) {
  const text = String(command || '')
  if (!text.trim()) return null
  const workdir = path.resolve(String(args.workdir || args.cwd || config.hostProfileDir || process.cwd()))

  // dsh plugin [--profile desktop] add <spec>
  const dshPlugin = text.match(/\bdsh(?:\.cmd|\.exe)?\b[^\n;&|]*?\bplugin\b[^\n;&|]*?\b(add|install)\b([^\n;&|]*)/i)
  if (dshPlugin) {
    const rest = dshPlugin[2] || ''
    const profileMatch = text.match(/--profile\s+["']?([A-Za-z0-9._-]+)/i)
    const profile = profileMatch ? profileMatch[1] : HOST_PROFILE
    if (profile !== HOST_PROFILE) return null
    const spec = firstSpecToken(rest)
    if (!spec) return null
    return { via: 'dsh-plugin-add', spec, profile, command: text, workdir }
  }

  // pnpm/npm add 在主机 profile 目录里执行
  const pkgCmd = text.match(/\b(pnpm|npm|yarn)(?:\.cmd)?\b[^\n;&|]*?\b(add|install|i)\b([^\n;&|]*)/i)
  if (pkgCmd) {
    const hostProfile = normSlashes(config.hostProfileDir || '')
    const dirFlag = text.match(/--dir(?:=|\s+)["']?([^"'\s]+)/i)
    const targetDir = dirFlag ? path.resolve(dirFlag[1]) : workdir
    const inHostProfile =
      (hostProfile && normSlashes(targetDir).toLowerCase().startsWith(hostProfile.toLowerCase())) ||
      (hostProfile && normSlashes(text).toLowerCase().includes(hostProfile.toLowerCase()))
    if (!inHostProfile) return null
    const spec = firstSpecToken(pkgCmd[3] || '')
    if (!spec) return null
    return { via: `${pkgCmd[1]}-add`, spec, profile: HOST_PROFILE, command: text, workdir: targetDir }
  }

  return null
}

function firstSpecToken(rest) {
  const tokens = String(rest)
    .replace(/["']/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  return tokens.find((t) => !t.startsWith('-')) || ''
}

/** 把一次工具调用归一成安装意图；不是主机安装则返回 null。 */
export function extractInstallIntent(execution, config = {}) {
  const name = String(execution?.name || '')
  const args = execution?.arguments || {}

  if (name === 'plugin_manager') {
    if (String(args.action || '') === 'install_bundle' && args.target) {
      const spec = String(args.target)
      return {
        via: 'plugin_manager.install_bundle',
        spec,
        profile: HOST_PROFILE,
        command: `plugin_manager install_bundle ${spec}`,
        workdir: config.hostProfileDir,
      }
    }
    return null
  }

  if (!SHELL_TOOLS.has(name)) return null
  return parseInstallCommand(args.command || args.cmd || args.script || '', args, config)
}

function receiptDir(config) {
  if (!config?.sandboxRoot) return undefined
  try {
    return new GatePaths(config)
  } catch {
    return undefined
  }
}

/**
 * 纯判定：返回拒绝原因字符串表示拦截，返回 undefined 表示放行。
 * 供 tools.guard 与 `gate.mjs guard-check` 共用。
 */
export function evaluateInstallCall(execution, config = {}) {
  const intent = extractInstallIntent(execution, config)
  if (!intent) return undefined

  const resolved = resolveSpec(intent.spec, intent.workdir)
  const label = resolved.packageName || intent.spec

  // 守卫自身/升级自身不拦，否则无法安装这个守卫插件。
  if (resolved.packageName === GATE_PACKAGE || String(intent.spec).includes(GATE_PACKAGE)) return undefined

  const paths = receiptDir(config)
  const receipts = paths ? readReceipts(paths) : []

  // registry/远程源必须写明版本或提交，否则凭证无法绑定具体内容；
  // 不允许用“同名的旧凭证”放行一个会解析到新版本的安装。
  if (resolved.packageName && !resolved.version && !resolved.isPath) {
    return [
      `[sandbox-gate] 已拒绝主机安装：${label}（未指定版本/提交）`,
      `registry 或远程源安装必须写明版本（如 ${label}@x.y.z），否则无法确认它等于沙盒里通过测试的那一份。`,
      `先调用 sandbox_gate_install_test（path 或 spec），或改用 sandbox_gate_install 并带 confirm。`,
    ].join(' ')
  }

  const matched = receipts.find(
    (r) =>
      r.verdict === 'pass' &&
      r.packageName === resolved.packageName &&
      (!resolved.version || r.version === resolved.version) &&
      (!resolved.contentHash || !r.contentHash || r.contentHash === resolved.contentHash),
  )

  if (matched) return undefined

  const sameName = receipts.find((r) => r.verdict === 'pass' && r.packageName === resolved.packageName)
  const versionNote =
    sameName && resolved.version
      ? `（已有凭证版本 ${sameName.version}，本次要装 ${resolved.version}，版本不一致）`
      : ''

  return [
    `[sandbox-gate] 已拒绝主机安装：${label}${versionNote}`,
    `没有找到该包/版本在沙盒 install_test 中的 verdict=pass 凭证。`,
    `必须先调用 sandbox_gate_install_test（path 或 spec）并拿到 pass；`,
    `通过后再调用 sandbox_gate_install 完成主机安装。失败时把报告交给用户，不要直接安装。`,
  ].join(' ')
}

/** 在插件 apply 里注册守卫；返回 disposer。 */
export function registerGuard(ctx, config, log = () => {}) {
  const tools = ctx?.tools
  if (!tools || typeof tools.guard !== 'function') {
    log('[sandbox-gate] 当前 DSH 没有 tools.guard，主机安装守卫未注册')
    return { ok: false, reason: 'tools.guard unavailable' }
  }
  try {
    const dispose = tools.guard((execution) => {
      try {
        return evaluateInstallCall(execution, config)
      } catch (error) {
        log(`[sandbox-gate] guard 判定异常（放行）：${error.stack || error}`)
        return undefined
      }
    })
    log('[sandbox-gate] 主机安装守卫已注册')
    return { ok: true, dispose }
  } catch (error) {
    log(`[sandbox-gate] 守卫注册失败：${error.stack || error}`)
    return { ok: false, reason: String(error.message || error) }
  }
}

export function guardSelfTest() {
  // 用例里的「主机路径」现算，不写死任何作者机器目录。
  const hostDshHome = path.join(os.homedir(), '.dsh')
  const config = {
    sandboxRoot: process.env.DSH_GATE_SANDBOX_ROOT || path.join(os.homedir(), 'DSH-SandBox'),
    hostProfileDir: path.join(hostDshHome, 'profiles', 'desktop'),
    hostDshHome,
  }
  const cases = [
    { name: 'pwsh', arguments: { command: 'dsh plugin --profile desktop add dsh-receiptless-probe@1.0.0' }, expect: 'deny' },
    { name: 'pwsh', arguments: { command: 'pnpm add dsh-receiptless-probe@1.0.0', workdir: config.hostProfileDir }, expect: 'deny' },
    { name: 'plugin_manager', arguments: { action: 'install_bundle', target: 'dsh-receiptless-probe@1.0.0' }, expect: 'deny' },
    { name: 'pwsh', arguments: { command: 'dsh plugin --profile desktop add dsh-receiptless-probe' }, expect: 'deny' },
    { name: 'pwsh', arguments: { command: 'pnpm add left-pad', workdir: path.join(os.homedir(), 'work', 'demo') }, expect: 'allow' },
    { name: 'pwsh', arguments: { command: 'dsh plugin --profile web add dsh-receiptless-probe' }, expect: 'allow' },
    { name: 'read', arguments: { file_path: path.join(os.homedir(), 'x') }, expect: 'allow' },
    { name: 'pwsh', arguments: { command: 'dsh plugin --profile desktop add @kittensleepwalk/dsh-sandbox-gate' }, expect: 'allow' },
  ]
  return cases.map((c) => {
    const decision = evaluateInstallCall(c, config)
    return {
      call: `${c.name} ${JSON.stringify(c.arguments)}`,
      expect: c.expect,
      actual: decision ? 'deny' : 'allow',
      ok: (decision ? 'deny' : 'allow') === c.expect,
      reason: decision,
    }
  })
}

export { GATE_PACKAGE, HOST_PROFILE }
