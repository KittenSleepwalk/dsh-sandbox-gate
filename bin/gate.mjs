#!/usr/bin/env node
/**
 * dsh-sandbox-gate CLI —— 与插件工具共用同一套 lib，用于无模型、确定性的自测。
 *
 *   node bin/gate.mjs status
 *   node bin/gate.mjs calibrate [--force]
 *   node bin/gate.mjs sync [--dry-run]
 *   node bin/gate.mjs backup
 *   node bin/gate.mjs baseline [--force]
 *   node bin/gate.mjs audit --path <dir> | --spec <pkg>
 *   node bin/gate.mjs install-test --path <dir> [--restart-cycles 2] [--stability 60] [--gpu-wait 0]
 *   node bin/gate.mjs restart-test --run <id> [--cycles 1]
 *   node bin/gate.mjs rollback [--run <id>] [--no-self-check]
 *   node bin/gate.mjs interrupt --option continue|disallow_tool|suspend|stop [--run <id>]
 *   node bin/gate.mjs resume [--run <id>]
 *   node bin/gate.mjs logs [--run <id>] [--lines 80]
 *   node bin/gate.mjs self-check
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../lib/config.js'
import { GatePaths } from '../lib/paths.js'
import { calibrate, cachedInventory, detectHostCore, hostSnapshot, countSessions } from '../lib/host.js'
import { verifyBackup, buildBackup } from '../lib/backup.js'
import { auditCandidate } from '../lib/audit.js'
import { buildBaseline, verifyBaseline } from '../lib/baseline.js'
import { runInstallTest, runRestartTest, ensureBackup, ensureBaseline, baselineSelfCheck, writeReport } from '../lib/pipeline.js'
import { readInterrupt, writeInterrupt, clearInterrupt, readCheckpoint, INTERRUPT_OPTIONS, readReceipts } from '../lib/state.js'
import { evaluateInstallCall, guardSelfTest } from '../lib/guard.js'
import { hostInstall, previewHostInstall, listHostInstalls } from '../lib/host-install.js'
import { parityReport, syncLiveProfile } from '../lib/parity.js'
import { loadRun, disposeRun, saveRun } from '../lib/run.js'
import { createRun } from '../lib/run.js'
import { sampleGpu } from '../lib/hardware.js'
import { readJson, nowIso, tailFile } from '../lib/util.js'

const argv = process.argv.slice(2)
const command = argv[0]
const flags = parseFlags(argv.slice(1))

function parseFlags(list) {
  const out = {}
  for (let i = 0; i < list.length; i++) {
    const item = list[i]
    if (!item.startsWith('--')) continue
    const key = item.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    const next = list[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else {
      out[key] = next
      i++
    }
  }
  return out
}

const config = loadConfig({})
const paths = new GatePaths(config).ensureLayout()

function print(value) {
  console.log(JSON.stringify(value, null, 2))
}

async function main() {
  switch (command) {
    case 'status': {
      const inventory = readJson(paths.hostInventory)
      const baseline = readJson(paths.baselineManifest)
      const gate = readJson(paths.gateFile)
      const backup = verifyBackup(paths)
      const core = detectHostCore(config)
      print({
        sandboxRoot: config.sandboxRoot,
        host: { coreVersion: core.version, source: core.source, profileHash: inventory?.host?.profileHash ?? null },
        sandbox: {
          coreVersion: inventory?.sandbox?.coreVersion ?? null,
          installedCore: fs.existsSync(paths.coreDir(core.version || config.coreVersion)),
          sessions: countSessions(path.join(config.sandboxRoot, 'data', 'dsh-home')),
          baseline: baseline
            ? { fingerprint: baseline.fingerprint, coreVersion: baseline.coreVersion, plugins: baseline.plugins?.length, bundles: baseline.bundles?.length, baselineActive: baseline.baselineActive?.length, builtAt: baseline.builtAt }
            : null,
        },
        backup: { ok: backup.ok, dir: backup.dir, files: backup.files, error: backup.error },
        inventory: inventory ? { at: inventory.calibratedAt, installable: inventory.installableCount ?? inventory.deps?.length, excluded: inventory.excludedCount ?? inventory.excluded?.length } : null,
        parity: inventory ? parityReport(paths, config, inventory) : null,
        lastRun: gate,
        checkpoint: readCheckpoint(paths),
        interrupt: readInterrupt(paths),
        interruptOptions: INTERRUPT_OPTIONS,
        hostSnapshot: hostSnapshot(config),
      })
      return
    }
    case 'calibrate': {
      print(calibrate(paths, config, { force: Boolean(flags.force) }))
      return
    }
    case 'sync': {
      print(
        syncLiveProfile(paths, config, {
          dryRun: flags.dryRun === true || flags['dry-run'] === true,
          log: (m) => console.error(m),
        }),
      )
      return
    }
    case 'backup': {
      print(ensureBackup(paths, config))
      return
    }
    case 'backup-verify': {
      // 校验 <sandboxRoot>/backup/portable-* 里每个文件的 sha256（backup.js 生成的说明一直引用它）
      const report = verifyBackup(paths)
      print(report)
      if (!report.ok) process.exitCode = 1
      return
    }
    case 'baseline': {
      const inv = cachedInventory(paths, config, { force: Boolean(flags.force) }).inventory
      const built = await ensureBaseline(paths, config, inv, { force: Boolean(flags.force) }, (m) => console.error(m))
      print({ ...built, verify: verifyBaseline(paths) })
      return
    }
    case 'audit': {
      if (!flags.path && !flags.spec) throw new Error('需要 --path 或 --spec')
      print(auditCandidate(paths, config, { path: flags.path, spec: flags.spec }))
      return
    }
    case 'install-test': {
      if (!flags.path && !flags.spec) throw new Error('需要 --path 或 --spec')
      const result = await runInstallTest(paths, config, {
        path: flags.path,
        spec: flags.spec,
        restartCycles: flags.restartCycles !== undefined ? Number(flags.restartCycles) : undefined,
        stabilitySec: flags.stability !== undefined ? Number(flags.stability) : undefined,
        gpuWaitSec: flags.gpuWait !== undefined ? Number(flags.gpuWait) : 0,
        requireGpu: Boolean(flags.gpu),
        force: Boolean(flags.force),
        forceBaseline: Boolean(flags.forceBaseline),
        forceCalibrate: Boolean(flags.forceCalibrate),
        installLive: Boolean(flags.installLive),
        functionalCommand: flags.functionalCommand || flags.functional,
        log: (m) => console.error(`[gate] ${m}`),
      })
      print(result)
      return
    }
    case 'pipeline': {
      if (!flags.path && !flags.spec) throw new Error('需要 --path 或 --spec')
      const result = await runInstallTest(paths, config, {
        path: flags.path,
        spec: flags.spec,
        restartCycles: flags.restartCycles !== undefined ? Number(flags.restartCycles) : undefined,
        stabilitySec: flags.stability !== undefined ? Number(flags.stability) : undefined,
        gpuWaitSec: flags.gpuWait !== undefined ? Number(flags.gpuWait) : 0,
        requireGpu: Boolean(flags.gpu),
        force: Boolean(flags.force),
        installLive: flags.installLive !== false,
        functionalCommand: flags.functionalCommand || flags.functional,
        log: (m) => console.error(`[gate] ${m}`),
      })
      print(result)
      return
    }
    case 'restart-test': {
      print(await runRestartTest(paths, config, { runId: flags.run, cycles: flags.cycles ? Number(flags.cycles) : 1 }))
      return
    }
    case 'rollback': {
      const run = flags.run ? loadRun(paths, flags.run) : null
      const out = { ok: true, rolledBack: false, runId: run?.runId || null }
      if (run && run.stage !== 'disposed') {
        disposeRun(paths, run)
        run.stage = 'disposed'
        saveRun(paths, run)
        out.rolledBack = true
      }
      clearInterrupt(paths)
      if (flags.noSelfCheck !== true) {
        const manifest = readJson(paths.baselineManifest)
        if (manifest) {
          const check = await baselineSelfCheck(paths, config, manifest)
          out.selfCheck = check.test
          out.ok = check.test.status === 'pass'
        } else {
          out.ok = false
          out.selfCheck = { status: 'fail', detail: '尚无基线' }
        }
      }
      print(out)
      return
    }
    case 'hardware': {
      print(await sampleGpu())
      return
    }
    case 'self-check': {
      const manifest = readJson(paths.baselineManifest)
      if (!manifest) throw new Error('尚无基线，先运行 baseline')
      const check = await baselineSelfCheck(paths, config, manifest)
      print(check)
      return
    }
    case 'interrupt': {
      const option = flags.option
      if (!INTERRUPT_OPTIONS.some((o) => o.id === option)) throw new Error('option 必须是 ' + INTERRUPT_OPTIONS.map((o) => o.id).join('/'))
      const pending = readInterrupt(paths) || {}
      const record = { ...pending, option, decidedAt: nowIso(), reason: flags.reason || null }
      if (option === 'continue') {
        const runId = flags.run || pending.runId || readCheckpoint(paths)?.runId
        if (!runId) throw new Error('没有可续跑的副本（interrupt/checkpoint 都没有 runId）')
        clearInterrupt(paths)
        print({ ok: true, option, resume: await runRestartTest(paths, config, { runId, cycles: 1 }) })
        return
      }
      if (option === 'stop' || option === 'suspend' || option === 'disallow_tool') {
        writeInterrupt(paths, { ...record, stage: option === 'stop' ? 'stopped' : option === 'suspend' ? 'suspended' : 'disallowed' })
        print({ ok: true, option, record })
        return
      }
      return
    }
    case 'resume': {
      const cp = readCheckpoint(paths)
      const id = flags.run || cp?.runId
      if (!id) throw new Error('没有可续跑的断点')
      const run = loadRun(paths, id)
      if (!run || run.stage === 'disposed') throw new Error('副本已回退，需要重新安装测试')
      print({ ok: true, resume: await runRestartTest(paths, config, { runId: id, cycles: flags.cycles ? Number(flags.cycles) : 1 }) })
      return
    }
    case 'guard-check': {
      const command = flags.command || flags.cmd
      if (!command) throw new Error('需要 --command "<shell 命令>"')
      const execution = {
        name: flags.tool || 'pwsh',
        arguments: { command, workdir: flags.workdir || config.hostProfileDir },
      }
      print({ execution, decision: evaluateInstallCall(execution, config) || 'allow' })
      return
    }
    case 'guard-selftest': {
      const cases = guardSelfTest()
      print({ ok: cases.every((c) => c.ok), cases })
      return
    }
    case 'receipts': {
      print({
        receipts: readReceipts(paths),
        hostInstalls: listHostInstalls(paths),
      })
      return
    }
    case 'host-install': {
      const args = {
        path: flags.path,
        spec: flags.spec,
        confirm: flags.confirm === true ? undefined : flags.confirm,
      }
      print(flags.confirm ? hostInstall(paths, config, args) : { preview: previewHostInstall(paths, config, args), hint: '传 --confirm <包名> 才会真正写入主机' })
      return
    }
    case 'logs': {
      const gate = readJson(paths.gateFile)
      const id = flags.run || gate?.lastRunId
      if (!id) throw new Error('没有历史 run')
      const dir = paths.evidenceDir(id)
      const report = readJson(path.join(dir, 'report.json'))
      const ev = report?.evidenceDir || dir
      const logs = fs.existsSync(ev) ? fs.readdirSync(ev).filter((f) => f.startsWith('boot-')).sort() : []
      print({
        runId: id,
        report,
        bootLog: logs.length ? tailFile(path.join(ev, logs[logs.length - 1]), Number(flags.lines || 80)) : null,
        canary: readJson(path.join(paths.runRoot(id), '.sandbox-gate', 'canary-out', 'status.json')),
      })
      return
    }
    case 'clean': {
      const keep = Number(flags.keep || config.maxRunsKept)
      const dirs = fs.existsSync(paths.runs)
        ? fs.readdirSync(paths.runs).map((n) => ({ n, m: fs.statSync(path.join(paths.runs, n)).mtimeMs })).sort((a, b) => b.m - a.m)
        : []
      const removed = []
      for (const d of dirs.slice(keep)) removed.push(d.n)
      print({ removed, kept: dirs.slice(0, keep).map((d) => d.n) })
      return
    }
    default:
      console.error(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 20).join('\n'))
      process.exitCode = 2
  }
}

main().catch((error) => {
  console.error('[gate] ERROR', error?.stack || error)
  process.exitCode = 1
})
