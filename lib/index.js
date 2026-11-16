/**
 * 插件设计及安装的必须沙盒校验（dsh-sandbox-gate）
 *
 * 所有会改动状态的工具都只操作 <sandboxRoot>/.sandbox-gate/**，
 * 绝不写入主机 profile，也绝不占用主机 GUI 端口。
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig, sandboxNode } from './config.js'
import { GatePaths } from './paths.js'
import { cachedInventory, calibrate, hostSnapshot, detectHostCore, countSessions } from './host.js'
import { buildBackup, verifyBackup } from './backup.js'
import { auditCandidate } from './audit.js'
import { sampleIdle, sampleGpu } from './hardware.js'
import { readJson, nowIso, tailFile, rmrf, ensureDir } from './util.js'
import { createRun, loadRun, disposeRun, saveRun } from './run.js'
import { readInterrupt, writeInterrupt, clearInterrupt, readCheckpoint, saveCheckpoint, INTERRUPT_OPTIONS, acquireLock, releaseLock } from './state.js'
import { runInstallTest, runRestartTest, ensureBackup, ensureBaseline, baselineSelfCheck, writeReport, failedItems } from './pipeline.js'
import { registerGuard, guardSelfTest } from './guard.js'
import { hostInstall, previewHostInstall, listHostInstalls } from './host-install.js'
import { parityReport, syncLiveProfile } from './parity.js'
import { readReceipts } from './state.js'

export const name = 'sandbox-gate'
// tools 是 DSH 工具内核的必需服务；直接注入，插件才能注册工具。
export const inject = ['tools']

const CONFIG_PROPS = {
  sandboxRoot: { type: 'string', description: '沙盒根目录（默认 DSH_GATE_SANDBOX_ROOT 或 ~/DSH-SandBox）' },
  hostProfileDir: { type: 'string', description: '主机 Desktop profile（默认 ~/.dsh/profiles/desktop）' },
  hostDshHome: { type: 'string', description: '主机 DSH_HOME（默认 ~/.dsh）' },
}

function cfg(patch = {}, args = {}) {
  const overrides = {
    ...patch,
    ...(args.sandboxRoot ? { sandboxRoot: args.sandboxRoot } : {}),
    ...(args.hostProfileDir ? { hostProfileDir: args.hostProfileDir } : {}),
    ...(args.hostDshHome ? { hostDshHome: args.hostDshHome } : {}),
  }
  const config = loadConfig(overrides)
  return { config, paths: new GatePaths(config).ensureLayout() }
}

const OUT = (description) => ({
  schema: { type: 'object', additionalProperties: true },
  render: (_args, result) => [
    {
      type: 'text',
      text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
    },
  ],
})

function tool(definition) {
  const execute = definition.execute
  return {
    ...definition,
    output: definition.output || OUT(),
    async execute(...args) {
      const result = await execute(...args)
      return toLossless(result)
    },
  }
}

// DSH 的工具结果必须是 lossless JSON：undefined / NaN / Infinity / 函数都不能出现。
function toLossless(value) {
  if (value === undefined) return null
  try {
    const text = JSON.stringify(value)
    return text === undefined ? null : JSON.parse(text)
  } catch {
    return { ok: false, error: 'tool output is not serializable' }
  }
}

export function apply(ctx, patchConfig = {}) {
  const register = () => {
    let tools = null
    try {
      tools = ctx.tools
    } catch {
      /* 未注入 tools 时不能直接取属性 */
    }
    tools = tools || ctx.reflect?.get?.('tools')
    if (!tools || typeof tools.register !== 'function') return false
    for (const def of buildTools(patchConfig)) tools.register(tool(def))
    // 工具层守卫：没有 install_test 凭证的主机安装调用会被直接拒绝。
    const config = loadConfig(patchConfig)
    registerGuard(ctx, config, (line) => {
      try {
        console.error(line)
      } catch {
        /* ignore */
      }
    })
    return true
  }
  if (!register() && typeof ctx.inject === 'function') {
    ctx.inject(['tools'], () => register())
  }
}

function buildTools(patch = {}) {
  return [
    {
      name: 'sandbox_gate_status',
      description:
        '查看沙盒校验环境状态：主机核心版本、插件盘点缓存、基线指纹、备份完整性、最近一次测试结论、待处理的用户中断、GPU 占用。只读，不启动进程。',
      parameters: { type: 'object', properties: { ...CONFIG_PROPS }, additionalProperties: false },
      async execute(args = {}) {
        const { config, paths } = cfg(patch, args)
        const inventory = readJson(paths.hostInventory)
        const baseline = readJson(paths.baselineManifest)
        const gate = readJson(paths.gateFile)
        const checkpoint = readCheckpoint(paths)
        const interrupt = readInterrupt(paths)
        const backup = verifyBackup(paths)
        const core = detectHostCore(config)
        const liveProfile = path.join(config.sandboxRoot, 'data', 'dsh-home', 'profiles', config.baselineProfile)
        const livePkg = readJson(path.join(liveProfile, 'package.json')) || {}
        const liveCanary = readJson(path.join(config.sandboxRoot, 'data', 'dsh-home', 'canary-out', 'status.json'))
        const liveCore = readJson(
          path.join(path.dirname(path.dirname(sandboxNode(config))), 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
        )
        const parity = inventory ? parityReport(paths, config, inventory) : null
        return {
          sandboxRoot: config.sandboxRoot,
          host: { coreVersion: core.version, source: core.source, profileDir: config.hostProfileDir, profileHash: inventory?.host?.profileHash ?? null },
          sandbox: {
            coreVersion: inventory?.sandbox?.coreVersion ?? null,
            installedCore: fs.existsSync(paths.coreDir(core.version || config.coreVersion)),
            sessions: countSessions(path.join(config.sandboxRoot, 'data', 'dsh-home')),
            baseline: baseline
              ? {
                  fingerprint: baseline.fingerprint,
                  coreVersion: baseline.coreVersion,
                  plugins: baseline.plugins?.length ?? 0,
                  bundles: baseline.bundles?.length ?? 0,
                  baselineActive: baseline.baselineActive?.length ?? null,
                  builtAt: baseline.builtAt,
                }
              : null,
          },
          live: {
            profile: liveProfile,
            coreVersion: liveCore?.version ?? null,
            gateRegistered: Boolean(livePkg.dependencies?.['@kittensleepwalk/dsh-sandbox-gate']),
            pluginCount: Object.keys(livePkg.dependencies ?? {}).length,
            canary: liveCanary
              ? {
                  active: liveCanary.counts?.active ?? null,
                  failed: liveCanary.counts?.failed ?? null,
                  total: liveCanary.counts?.total ?? null,
                  updatedAt: liveCanary.updatedAt ?? null,
                  fresh: Boolean(liveCanary.updatedAt && Date.now() - Date.parse(liveCanary.updatedAt) < 15000),
                }
              : null,
          },
          parity: parity
            ? {
                ok: parity.ok,
                hostCount: parity.hostCount,
                liveCount: parity.liveCount,
                missing: parity.missing,
                extra: parity.extra,
                gateInstalled: parity.gateInstalled,
                canaryInjected: parity.canaryInjected,
              }
            : null,
          backup: { ok: backup.ok, dir: backup.dir, files: backup.files, error: backup.error },
          inventory: inventory
            ? { at: inventory.calibratedAt, installable: inventory.installableCount ?? inventory.deps?.length, excluded: inventory.excludedCount ?? inventory.excluded?.length }
            : null,
          lastRun: gate || null,
          checkpoint,
          interrupt,
          interruptOptions: INTERRUPT_OPTIONS,
          hostSnapshot: hostSnapshot(config),
        }
      },
    },
    {
      name: 'sandbox_gate_calibrate',
      description:
        '校准主机 DeepSeek Harness Desktop 的核心版本与插件列表，写入 .sandbox-gate/host-inventory.json 缓存；后续工具直接复用，避免每次花 token 重扫。不修改主机。',
      parameters: { type: 'object', properties: { force: { type: 'boolean' }, ...CONFIG_PROPS }, additionalProperties: false },
      async execute(args = {}) {
        const { config, paths } = cfg(patch, args)
        const result = calibrate(paths, config)
        return {
          ok: true,
          host: result.host,
          installable: result.deps.length,
          excluded: result.excluded.map((e) => ({ name: e.name, reason: e.reason })),
          bundles: result.bundles.length,
          cachedAt: result.calibratedAt,
        }
      },
    },
    {
      name: 'sandbox_gate_audit',
      description:
        '静态审计一个待安装插件（本地目录或 npm 包名）：entry/bundle/patch 结构、dsh 引擎版本、主机绝对路径、端口占用、进程退出、符号链接、entry id 冲突。返回 ok/warn/reject，不安装、不启动沙盒。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, spec: { type: 'string' }, ...CONFIG_PROPS },
        additionalProperties: false,
      },
      async execute(args = {}) {
        const { config, paths } = cfg(patch, args)
        if (!args.path && !args.spec) return { ok: false, error: '需要 path 或 spec' }
        const audit = auditCandidate(paths, config, { path: args.path, spec: args.spec })
        return {
          verdict: audit.verdict,
          name: audit.name,
          version: audit.version,
          findings: audit.findings,
          summary: audit.summary,
        }
      },
    },
    {
      name: 'sandbox_gate_install_test',
      description:
        '核心工具：把候选插件装进一次性沙盒副本并做完整测试（启动、2 次冷重启、session 完整性、其他插件是否崩、候选是否挂载、稳定性、主机隔离、回退后基线可用）。任何失败只影响副本，测试后副本被丢弃，主机零改动。GPU 忙时会拒绝启动。耗时数分钟。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '本地插件目录（绝对路径）' },
          spec: { type: 'string', description: 'npm 包名 / git / 文件 spec' },
          restartCycles: { type: 'number' },
          stabilitySec: { type: 'number' },
          gpuWaitSec: { type: 'number', description: 'GPU 忙时最多等待秒数，0 表示不等待直接拒绝' },
          force: { type: 'boolean', description: '审计 warn/reject 仍继续（危险，仅用户明确要求）' },
          forceBaseline: { type: 'boolean' },
          forceCalibrate: { type: 'boolean' },
          allowInstallScripts: { type: 'boolean' },
          installLive: {
            type: 'boolean',
            description: '测试通过后把候选装进 live 沙盒插件列表（保留），并启动 live 沙盒验证候选 active；失败会回滚 live 安装',
          },
          functionalCommand: {
            type: 'string',
            description: 'live 启动后执行的功能检查命令（cwd=沙盒根），退出码 0 视为功能通过；用于 T17',
          },
          ...CONFIG_PROPS,
        },
        additionalProperties: false,
      },
      async execute(args = {}) {
        const { config, paths } = cfg(patch, args)
        return runInstallTest(paths, config, args)
      },
    },
    {
      name: 'sandbox_gate_pipeline',
      description:
        '沙盒插件设计/安装的固定流程：① 静态审计 ② 装进一次性副本做系统级测试（启动、冷重启、session、其他插件、稳定性、启动时延）③ 通过后装进 live 沙盒列表并启动验证 ④ 跑功能检查命令。任何一步失败都回退，不碰主机。测试沙盒插件本身时，由拟主机 dsh 调这个工具；装到主机后由主机 dsh 调同一个流程。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '本地插件目录（绝对路径）' },
          spec: { type: 'string', description: 'npm 包名 / git / 文件 spec' },
          functionalCommand: { type: 'string', description: '功能检查命令；不传则只做系统级测试' },
          installLive: { type: 'boolean', description: '默认 true；false 时只做一次性副本测试，不改 live 沙盒列表' },
          restartCycles: { type: 'number' },
          stabilitySec: { type: 'number' },
          gpuWaitSec: { type: 'number' },
          force: { type: 'boolean' },
          ...CONFIG_PROPS,
        },
        additionalProperties: false,
      },
      async execute(args = {}) {
        const { config, paths } = cfg(patch, args)
        return runInstallTest(paths, config, { ...args, installLive: args.installLive !== false })
      },
    },
    {
      name: 'sandbox_gate_restart_test',
      description: '对已安装候选的一次性运行副本再做冷重启测试（不重新安装），验证重启后 session 与其他插件是否仍正常。',
      parameters: {
        type: 'object',
        properties: { runId: { type: 'string' }, cycles: { type: 'number' }, ...CONFIG_PROPS },
        additionalProperties: false,
      },
      async execute(args = {}) {
        const { config, paths } = cfg(patch, args)
        return runRestartTest(paths, config, args)
      },
    },
    {
      name: 'sandbox_gate_rollback',
      description: '回退：丢弃候选的一次性运行副本（rm -rf），恢复只能从只读基线重新复制；随后启动一次基线自检，证明沙盒仍然可用。主机不受影响。',
      parameters: {
        type: 'object',
        properties: { runId: { type: 'string' }, selfCheck: { type: 'boolean' }, ...CONFIG_PROPS },
        additionalProperties: false,
      },
      async execute(args = {}) {
        const { config, paths } = cfg(patch, args)
        const run = args.runId ? loadRun(paths, args.runId) : latestRun(paths)
        const result = { ok: true, rolledBack: false, runId: run?.runId || null }
        if (run && run.stage !== 'disposed') {
          disposeRun(paths, run)
          run.stage = 'disposed'
          saveRun(paths, run)
          result.rolledBack = true
        }
        clearInterrupt(paths)
        if (args.selfCheck !== false) {
          const manifest = readJson(paths.baselineManifest)
          if (manifest) {
            const check = await baselineSelfCheck(paths, config, manifest)
            result.selfCheck = check.test
            result.ok = check.test.status === 'pass'
          } else {
            result.ok = false
            result.selfCheck = { status: 'fail', detail: '尚无基线，需先 sandbox_gate_calibrate + install_test 生成基线' }
          }
        }
        return result
      },
    },
    {
      name: 'sandbox_gate_hardware',
      description:
        '采样本机 GPU（nvidia-smi）与占卡进程，判断是否适合跑需要显卡的插件测试；可选等待直到空闲。用户正在用显卡时不要强行测试。',
      parameters: { type: 'object', properties: { waitSec: { type: 'number' }, ...CONFIG_PROPS }, additionalProperties: false },
      async execute(args = {}) {
        const { config } = cfg(patch, args)
        const immediate = await sampleGpu(config.gpu)
        if (args.waitSec > 0 && !(await sampleIdle(config.gpu)).idle) {
          const started = Date.now()
          while ((Date.now() - started) / 1000 < args.waitSec) {
            await new Promise((r) => setTimeout(r, 15000))
            const s = await sampleIdle(config.gpu)
            if (s.idle) return { idle: true, waitedSec: Math.round((Date.now() - started) / 1000), sample: s }
          }
        }
        return { idle: immediate.idle, sample: immediate }
      },
    },
    {
      name: 'sandbox_gate_interrupt',
      description:
        '用户强杀/退出沙盒进程后处理：绝不自动重启。option=continue 继续工具测试（用户确认工具合法）；disallow_tool 不允许当前工具使用（用户确认合法但拒绝）；suspend 挂起直到用户手动或轮询恢复；stop 彻底停止本次插件设计（保留断点，之后说“继续任务”可续）。',
      parameters: {
        type: 'object',
        properties: {
          option: { type: 'string', enum: ['continue', 'disallow_tool', 'suspend', 'stop'] },
          runId: { type: 'string' },
          reason: { type: 'string' },
          ...CONFIG_PROPS,
        },
        required: ['option'],
        additionalProperties: false,
      },
      async execute(args = {}) {
        const { config, paths } = cfg(patch, args)
        const run = args.runId ? loadRun(paths, args.runId) : latestRun(paths)
        const pending = readInterrupt(paths)
        const record = { ...(pending || {}), option: args.option, decidedAt: nowIso(), reason: args.reason || null }
        if (args.option === 'continue') {
          clearInterrupt(paths)
          if (!run) return { ok: false, error: '没有可续跑的副本' }
          const resumed = await runRestartTest(paths, config, { runId: run.runId, cycles: 1 })
          return { ok: resumed.status === 'pass', option: 'continue', resume: resumed }
        }
        if (args.option === 'disallow_tool') {
          writeInterrupt(paths, { ...record, stage: 'disallowed' })
          return { ok: true, option: 'disallow_tool', detail: '已记录：当前工具被用户判定为不允许使用，请更换设计方案，不要重启该工具' }
        }
        if (args.option === 'suspend') {
          writeInterrupt(paths, { ...record, stage: 'suspended' })
          return { ok: true, option: 'suspend', detail: '已挂起；用户手动或 agent 轮询硬件空闲后再调用 sandbox_gate_resume' }
        }
        if (args.option === 'stop') {
          writeInterrupt(paths, { ...record, stage: 'stopped' })
          if (run && run.stage !== 'disposed') {
            // 停止设计但保留副本与断点，便于“继续任务”
            const checkpoint = readCheckpoint(paths)
            saveCheckpoint(paths, { ...(checkpoint || {}), runId: run.runId, stage: 'stopped', stoppedAt: nowIso(), candidate: run.candidate })
          }
          return { ok: true, option: 'stop', detail: '已彻底停止本次插件设计；沙盒副本保留，主机不受影响。用户说“继续任务”时调用 sandbox_gate_resume' }
        }
        return { ok: false, error: 'unknown option' }
      },
    },
    {
      name: 'sandbox_gate_resume',
      description: '从断点继续插件设计（用户说“继续任务”时）：读取 checkpoint / 未丢弃副本，重新做重启与完整性测试；若副本已被回退，则提示重新安装。',
      parameters: { type: 'object', properties: { runId: { type: 'string' }, cycles: { type: 'number' }, ...CONFIG_PROPS }, additionalProperties: false },
      async execute(args = {}) {
        const { config, paths } = cfg(patch, args)
        const checkpoint = readCheckpoint(paths)
        const runId = args.runId || checkpoint?.runId
        if (!runId) return { ok: false, error: '没有可续跑的断点' }
        const run = loadRun(paths, runId)
        if (!run || run.stage === 'disposed') {
          return { ok: false, error: '副本已被回退，需要重新调用 sandbox_gate_install_test 安装测试' }
        }
        const result = await runRestartTest(paths, config, { runId, cycles: args.cycles ?? 1 })
        return { ok: result.status === 'pass', resume: result }
      },
    },
    {
      name: 'sandbox_gate_install',
      description:
        '通过沙盒校验后，把候选插件完整安装到主机 Desktop profile（本地目录先 pnpm pack 成 tarball 再安装，不用 link；tarball 留档在主机 .dsh/plugin-archives）。硬性前置：install_test 必须已产出同包同版本的 verdict=pass 凭证，且 path 候选内容未再改动。必须传 confirm=<包名> 作为明确确认。只改主机 profile，不重启主机；返回 needsRestart=true 后由用户决定何时重启。没有凭证时本工具会拒绝，不会安装。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '本地插件目录（绝对路径）' },
          spec: { type: 'string', description: 'npm 包名 / git / 文件 spec' },
          confirm: { type: 'string', description: '必须等于包名，表示确认写入主机' },
          ...CONFIG_PROPS,
        },
        additionalProperties: false,
      },
      async execute(args = {}) {
        const { config, paths } = cfg(patch, args)
        if (!args.confirm) return { ok: false, preview: previewHostInstall(paths, config, args) }
        return hostInstall(paths, config, args)
      },
    },
    {
      name: 'sandbox_gate_receipts',
      description:
        '查看 install_test 产出的通过凭证（包名/版本/内容哈希/runId）与主机安装记录。agent 在调用 sandbox_gate_install 前可用它确认凭证是否存在；只读。',
      parameters: { type: 'object', properties: { ...CONFIG_PROPS }, additionalProperties: false },
      async execute(args = {}) {
        const { paths } = cfg(patch, args)
        return {
          receipts: readReceipts(paths).map((r) => ({
            packageName: r.packageName,
            version: r.version,
            verdict: r.verdict,
            contentHash: r.contentHash,
            runId: r.runId,
            at: r.recordedAt,
          })),
          hostInstalls: listHostInstalls(paths),
        }
      },
    },
    {
      name: 'sandbox_gate_guard_test',
      description:
        '自测主机安装守卫的判定表（shell 直接 add、主机 profile pnpm add、plugin_manager install_bundle 应被拒绝；其他目录/其他 profile/本插件自身应放行）。不执行安装、不写主机。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        const cases = guardSelfTest()
        return { ok: cases.every((c) => c.ok), cases }
      },
    },
    {
      name: 'sandbox_gate_sync',
      description:
        '对齐沙盒 live profile 与主机插件清单：主机所有可安装插件都必须存在（沙盒插件自身除外），缺的用 link: 指向主机已安装目录补全；可多不可少。默认会移除沙盒插件自身和 canary 注入，保持沙盒列表干净。只改沙盒，不写主机。',
      parameters: {
        type: 'object',
        properties: { dryRun: { type: 'boolean', description: '只比对并返回计划，不写文件、不安装' }, ...CONFIG_PROPS },
        additionalProperties: false,
      },
      async execute(args = {}) {
        const { config, paths } = cfg(patch, args)
        return syncLiveProfile(paths, config, {
          dryRun: args.dryRun === true,
          log: (line) => console.error(String(line)),
        })
      },
    },
    {
      name: 'sandbox_gate_logs',
      description: '读取最近一次（或指定 run）的校验报告、启动日志尾部、canary 快照，用于定位是哪一项测试失败。',
      parameters: {
        type: 'object',
        properties: { runId: { type: 'string' }, lines: { type: 'number' }, ...CONFIG_PROPS },
        additionalProperties: false,
      },
      async execute(args = {}) {
        const { paths } = cfg(patch, args)
        const gate = readJson(paths.gateFile)
        const runId = args.runId || gate?.lastRunId
        if (!runId) return { ok: false, error: '没有历史 run' }
        const dir = paths.evidenceDir(runId)
        const report = readJson(path.join(dir, 'report.json'))
        const evidenceDir = report?.evidenceDir || dir
        const bootLogs = fs.existsSync(evidenceDir)
          ? fs.readdirSync(evidenceDir).filter((f) => f.startsWith('boot-')).sort()
          : []
        const latest = bootLogs.length ? path.join(evidenceDir, bootLogs[bootLogs.length - 1]) : null
        return {
          runId,
          report,
          reportMd: path.join(dir, 'report.md'),
          bootLog: latest ? tailFile(latest, args.lines || 80) : null,
          canary: readJson(path.join(paths.runRoot(runId), '.sandbox-gate', 'canary-out', 'status.json')),
        }
      },
    },
  ]
}

function latestRun(paths) {
  if (!fs.existsSync(paths.runs)) return null
  const dirs = fs
    .readdirSync(paths.runs)
    .map((name) => ({ name, at: fs.statSync(path.join(paths.runs, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
  for (const d of dirs) {
    const run = loadRun(paths, d.name)
    if (run) return run
  }
  return null
}
