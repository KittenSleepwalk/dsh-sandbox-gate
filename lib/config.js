import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

/**
 * 默认沙盒根。
 *
 * 发布版不写死任何作者机器路径：默认落在用户目录下的 `DSH-SandBox`。
 * 需要固定位置时设环境变量 `DSH_GATE_SANDBOX_ROOT`，或给工具传 `sandboxRoot`。
 */
export const DEFAULT_SANDBOX_ROOT =
  process.env.DSH_GATE_SANDBOX_ROOT || path.join(os.homedir(), 'DSH-SandBox')

export const FORBIDDEN_PORTS = [8889, 18787]

export function loadConfig(overrides = {}) {
  const sandboxRoot = path.resolve(
    overrides.sandboxRoot ||
      process.env.DSH_GATE_SANDBOX_ROOT ||
      DEFAULT_SANDBOX_ROOT,
  )
  const hostDshHome = path.resolve(
    overrides.hostDshHome || process.env.DSH_GATE_HOST_HOME || path.join(os.homedir(), '.dsh'),
  )
  const hostProfileDir = path.resolve(
    overrides.hostProfileDir ||
      process.env.DSH_GATE_HOST_PROFILE ||
      path.join(hostDshHome, 'profiles', 'desktop'),
  )
  const baselineProfile = overrides.baselineProfile || 'web'
  const portBase = Number(overrides.portBase || process.env.DSH_GATE_PORT_BASE || 19001)
  const coreVersion = overrides.coreVersion || process.env.DSH_GATE_CORE_VERSION || null

  return {
    sandboxRoot,
    hostDshHome,
    hostProfileDir,
    baselineProfile,
    portBase: FORBIDDEN_PORTS.includes(portBase) ? 19001 : portBase,
    forbiddenPorts: [...FORBIDDEN_PORTS],
    coreVersion,
    stabilitySec: Number(overrides.stabilitySec || 60),
    restartCycles: Number(overrides.restartCycles || 2),
    bootTimeoutSec: Number(overrides.bootTimeoutSec || 90),
  // 正常冷启动实测 26–32s（211 个插件），留出波动余量；45s 卡死仍会被 T15 抓住。
  bootSlowMs: Number(overrides.bootSlowMs || 40000),
    maxRunsKept: Number(overrides.maxRunsKept || 3),
    gpu: {
      enabled: overrides.gpu?.enabled !== false,
      // “用户大概率空闲”：连续 samples 次采样都低于阈值。
      // 桌面常驻（浏览器/壁纸/DWM）本身就会占 5–8GB 显存、20–30% 利用率，
      // 所以阈值取“mean util ≤40% 且显存 ≤65%”，连续 3 次采样都满足才算空闲；
      // 游戏/大模型/出图这类真实重负载会稳定顶到 70%+ 或显存接近满。
      utilMax: overrides.gpu?.utilMax ?? 40,
      memMaxPct: overrides.gpu?.memMaxPct ?? 65,
      samples: overrides.gpu?.samples ?? 3,
      intervalMs: overrides.gpu?.intervalMs ?? 5000,
    },
    // 沙盒内允许安装的插件（排除主机桌面外壳）
    excludePlugins: overrides.excludePlugins || [
      'dsh-tauri',
      'dsh-tauri-archive',
      'dsh-tauri-extension',
      'dsh-tauri-model',
      'dsh-tauri-notification',
      'dsh-tauri-remote',
      'dsh-tauri-rightclick',
      'dsh-tauri-ui',
      'dsh-taiwind',
    ],
  }
}

export function assertSandbox(config) {
  if (!fs.existsSync(config.sandboxRoot)) {
    throw new Error(`沙盒根不存在：${config.sandboxRoot}`)
  }
  const portable = path.join(config.sandboxRoot, 'scripts', 'portable.mjs')
  if (!fs.existsSync(portable)) {
    throw new Error(`目录不像 Deepseek Harness SandBox（缺少 scripts/portable.mjs）：${config.sandboxRoot}`)
  }
  return true
}

export function sandboxDshBin(config) {
  return path.join(
    config.sandboxRoot,
    'runtimes',
    'windows-x64',
    'dsh',
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'lib',
    'bin.js',
  )
}

export function sandboxNode(config) {
  return path.join(config.sandboxRoot, 'runtimes', 'windows-x64', 'node', 'node.exe')
}

export function sandboxPnpmCli(config) {
  return path.join(
    config.sandboxRoot,
    'runtimes',
    'windows-x64',
    'dsh',
    'node_modules',
    'pnpm',
    'bin',
    'pnpm.cjs',
  )
}
