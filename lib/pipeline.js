import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, readJson, writeJsonAtomic, writeTextAtomic, nowIso, sha256File, rmrf, sleep, exec } from './util.js'
import { cachedInventory, hostSnapshot, detectHostCore, countSessions } from './host.js'
import { buildBackup, verifyBackup } from './backup.js'
import { buildBaseline, verifyBaseline } from './baseline.js'
import { auditCandidate, auditVerdictForInstall } from './audit.js'
import { sampleIdle, waitForIdle, sampleGpu } from './hardware.js'
import { createRun, stageCandidate, disposeRun, saveRun, loadRun } from './run.js'
import { launchDsh, waitForBoot, waitForCanary, httpStatus, readCanary, pickPort, stopDsh, killTree, canaryPath } from './launch.js'
import { scanSessions, compareSessions } from './sessions.js'
import { acquireLock, releaseLock, saveCheckpoint, readCheckpoint, writeInterrupt, readInterrupt, INTERRUPT_OPTIONS, writeReceipt } from './state.js'
import { installIntoLive, rollbackLiveInstall, verifyLiveBoot, runFunctionalCommand } from './live.js'

const REQUIRED = ['T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T08', 'T09', 'T15']

export function ensureBackup(paths, config) {
  const existing = verifyBackup(paths)
  if (existing.ok) return { ok: true, cached: true, detail: existing }
  const built = buildBackup(paths, config)
  if (!built.ok) return { ok: false, error: built.error || '无法建立便携发行备份' }
  const verified = verifyBackup(paths)
  return { ok: verified.ok, detail: verified, built }
}

export async function ensureBaseline(paths, config, inventory, options = {}, log = () => {}) {
  const built = buildBaseline(paths, config, inventory, { ...options, log })
  if (!built.ok) return { ok: false, error: built.error, detail: built }
  const manifest = readJson(paths.baselineManifest)
  const verify = verifyBaseline(paths)
  if (!verify.ok) {
    return { ok: false, error: '基线指纹校验失败（可能被改动），请 force 重建基线', detail: verify }
  }
  if (!manifest.baselineActive?.length || !manifest.selfCheckedAt || manifest.baselineRecordVersion !== 4) {
    log('基线尚未记录 active 插件集合，执行一次基线自检启动')
    const run = createRun(paths, config, manifest, { candidate: null, restartCycles: 0, stabilitySec: 10 })
    let result
    try {
      run.port = await pickPort(config)
      result = await bootOnce(paths, config, run, { observeSec: 10, requireCandidate: false })
      const bootFatal = ['T01', 'T03', 'T06'].filter((id) => result.tests[id]?.status === 'fail')
      if (bootFatal.length) {
        return { ok: false, error: '基线自检启动失败：' + JSON.stringify(result.tests) }
      }
      manifest.baselineActive = (result.canary?.rows || [])
        .filter((r) => r.phase === 'active' && !r.isGroup)
        .map((r) => normalizeEntryName(r.name || r.id))
        .filter(Boolean)
      manifest.baselineEntryCount = result.canary?.counts?.total || 0
      manifest.baselineNoise = result.logNoise || null
      manifest.baselineWarnings = (result.canary?.rows || [])
        .filter((r) => r.phase !== 'active')
        .map((r) => `${r.name || r.id}:${r.phase}`)
      manifest.selfCheckedAt = nowIso()
      manifest.baselineRecordVersion = 4
      writeJsonAtomic(paths.baselineManifest, manifest)
    } finally {
      await stopDsh(result?.handle)
      disposeRun(paths, run)
    }
  }
  return { ok: true, manifest }
}

/** 若 profile 的 cordis.patch.yml 被写坏（空文件/非数组），从快照或基线恢复。 */
function ensureProfilePatch(paths, run) {
  const profileDir = path.join(run.root, 'data', 'dsh-home', 'profiles', run.profile)
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  let text = ''
  try {
    text = fs.readFileSync(patchFile, 'utf8')
  } catch {
    text = ''
  }
  if (/^\s*(-\s|\[)/m.test(text)) return { restored: false }
  const candidates = [
    path.join(run.root, '.sandbox-gate', 'profile-patch.yml'),
    path.join(paths.baseline, 'root', 'data', 'dsh-home', 'profiles', run.profile, 'cordis.patch.yml'),
  ]
  for (const src of candidates) {
    if (src === patchFile || !fs.existsSync(src)) continue
    const good = fs.readFileSync(src, 'utf8')
    if (!/^\s*(-\s|\[)/m.test(good)) continue
    ensureDir(path.dirname(patchFile))
    fs.copyFileSync(src, patchFile)
    return { restored: true, from: src }
  }
  return { restored: false, missing: true }
}

/** 启动一次并做 T01/T03/T04/T05/T06 观测。 */
export async function bootOnce(paths, config, run, options = {}) {
  const observeSec = options.observeSec ?? config.stabilitySec
  const requireCandidate = options.requireCandidate !== false
  const evidenceDir = paths.evidenceDir(run.runId)
  ensureDir(evidenceDir)
  const tests = {}
  ensureProfilePatch(paths, run)
  const sessionsBefore = scanSessions(path.join(run.root, 'data', 'dsh-home'))
  const handle = launchDsh(run, config)
  run.pid = handle.pid
  saveRun(paths, run)

  const bootStarted = Date.now()
  const boot = await waitForBoot(handle, config.bootTimeoutSec)
  const bootMs = Date.now() - bootStarted
  if (!boot.ok) {
    // 启动阶段就退出 = 插件自身让沙盒崩溃（用户强杀通常发生在启动之后、工具跑起来时）。
    // 这里必须判失败并回退，不能当成“用户中断”保留现场。
    tests.T01 = {
      status: 'fail',
      detail: boot.reason === 'exited' ? `沙盒进程启动即退出（exit=${boot.exitCode}）` : `启动超时（${config.bootTimeoutSec}s）`,
      evidence: trim(boot.stderr || ''),
    }
    await stopDsh(handle)
    copyBootLog(run, evidenceDir)
    return { ok: false, tests, handle, interrupted: false, bootMs, sessionsBefore, canary: null, logNoise: null }
  }

  const http = await httpStatus(boot.url)
  tests.T01 = {
    status: http.ok ? 'pass' : 'fail',
    detail: `URL ${boot.url ? '已打印' : '缺失'}，HTTP ${http.status ?? http.error}，端口 ${boot.port}`,
    evidence: boot.url || '',
  }
  if (boot.port !== run.port) tests.T01.detail += `；端口不一致（期望 ${run.port}）`

  // T15 启动时延：apply() 里同步阻塞/死循环的“半成品”插件会拖慢启动。
  const bootSlowMs = config.bootSlowMs || 30000
  tests.T15 = {
    status: bootMs <= bootSlowMs ? 'pass' : 'fail',
    detail: `启动耗时 ${(bootMs / 1000).toFixed(1)}s（阈值 ${(bootSlowMs / 1000).toFixed(0)}s）`,
  }

  const canaryWait = await waitForCanary(run, 40)
  let canary = canaryWait.ok ? canaryWait.status : null
  if (!canary) {
    tests.T01.status = 'fail'
    tests.T01.detail += '；canary 未产出'
  } else if (canary.counts.failed > 0) {
    tests.T04 = {
      status: 'fail',
      detail: `canary 报告 ${canary.counts.failed} 个插件 failed：${canary.failed.map((f) => f.name || f.id).join(', ')}`,
      evidence: 'canary status.json',
    }
  }

  // T06 稳定性 / 心跳
  const baseline = readJson(paths.baselineManifest)
  const expectedActive = (baseline.baselineActive || []).length
  const stability = await observeStability(run, handle, Math.max(5, observeSec), expectedActive)
  tests.T06 = stability.test
  if (stability.externalKill) {
    // 用户强杀插件工具进程：不自动重启、不回退，停下来让用户四选一。
    return {
      ok: false,
      tests,
      handle,
      interrupted: true,
      externalKill: stability.externalKill,
      bootMs,
      sessionsBefore,
      canary,
      logNoise: null,
    }
  }
  // 观察结束后再取一次 canary：异步插件此时才进入最终态。
  canary = readCanary(run) || canary

  // T05 候选挂载（用稳定后的快照判定）
  if (requireCandidate && run.candidate?.packageName && canary) {
    const pkg = run.candidate.packageName
    const row = (canary.rows || []).find((r) => r.name === pkg || (r.name && r.name.includes(pkg)) || r.id === pkg)
    tests.T05 = row
      ? { status: row.phase === 'active' ? 'pass' : 'fail', detail: `候选 ${pkg} → ${row.phase}（id=${row.id}）` }
      : { status: 'fail', detail: `canary 中找不到候选 ${pkg}，插件可能未挂载` }
  } else if (requireCandidate && canary) {
    tests.T05 = { status: 'fail', detail: '候选包名未知' }
  }

  // T03 sessions
  const sessionsAfter = scanSessions(path.join(run.root, 'data', 'dsh-home'))
  const sessionCompare = compareSessions(sessionsBefore, sessionsAfter)
  tests.T03 = {
    status: sessionCompare.ok ? 'pass' : 'fail',
    detail: sessionCompare.ok
      ? `session ${sessionCompare.afterCount} 个，事件 ${sessionCompare.afterLines} 条，全部可解析`
      : sessionCompare.problems.join('；'),
    evidence: `before=${sessionCompare.beforeCount}/after=${sessionCompare.afterCount}`,
  }

  // T04 其他插件
  const activeIds = new Set(
    (canary?.rows || [])
      .filter((r) => r.phase === 'active' && !r.isGroup)
      .map((r) => normalizeEntryName(r.name || r.id)),
  )
  const missing = (baseline.baselineActive || []).filter((id) => !activeIds.has(id))
  const failedRows = (canary?.rows || []).filter((r) => r.phase === 'failed')
  if (!tests.T04) {
    tests.T04 =
      failedRows.length || missing.length
        ? {
            status: 'fail',
            detail: [
              failedRows.length ? `failed：${failedRows.map((f) => f.name || f.id).join(', ')}` : '',
              missing.length ? `基线插件不再 active：${missing.slice(0, 12).join(', ')}` : '',
            ]
              .filter(Boolean)
              .join('；'),
          }
        : { status: 'pass', detail: `基线 ${(baseline.baselineActive || []).length} 个插件全部 active，无 failed` }
  }

  const logNoise = scanLogNoise(handle, baseline.baselineNoise)
  // 首次自检还没有噪声样本时只记录不判失败；样本里包含主机同样的启动警告。
  if (baseline.baselineNoise && logNoise.newErrors.length && tests.T04.status === 'pass') {
    tests.T04 = {
      status: 'fail',
      detail: `启动日志出现新增错误：${logNoise.newErrors.slice(0, 5).join(' | ')}`,
    }
  }

  copyBootLog(run, evidenceDir)
  await stopDsh(handle)
  return {
    ok: Object.values(tests).every((t) => t.status !== 'fail'),
    tests,
    handle,
    interrupted: false,
    canary,
    sessionsBefore,
    sessionsAfter,
    logNoise,
    boot,
  }
}

function copyBootLog(run, evidenceDir) {
  const src = path.join(run.root, '.sandbox-gate', 'boot.log')
  if (fs.existsSync(src)) {
    try {
      fs.copyFileSync(src, path.join(evidenceDir, `boot-${Date.now()}.log`))
    } catch {
      /* ignore */
    }
  }
}

/**
 * 一次取全量进程表（比逐层递归 powershell 快一个数量级，避免把事件循环卡住）。
 * 只用于“用户强杀工具进程”的容错判断，不用于杀进程。
 */
function listProcesses() {
  try {
    const cmd = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'
    const r = exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 15000 })
    if (!r.ok || !r.stdout.trim()) return []
    let raw = JSON.parse(r.stdout)
    if (!Array.isArray(raw)) raw = [raw]
    return raw.map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, cmd: p.CommandLine || '' }))
  } catch {
    return []
  }
}

/** 从全量进程表算出 rootPid 的传递后代。 */
function descendantsOf(all, rootPid) {
  const byParent = new Map()
  for (const p of all) {
    if (!byParent.has(p.ppid)) byParent.set(p.ppid, [])
    byParent.get(p.ppid).push(p)
  }
  const out = []
  const queue = [Number(rootPid)]
  const seen = new Set(queue)
  while (queue.length) {
    const pid = queue.shift()
    for (const child of byParent.get(pid) || []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      out.push(child)
      queue.push(child.pid)
    }
  }
  return out
}

async function observeStability(run, handle, seconds, expectedActive = 0) {
  const started = Date.now()
  let maxGap = 0
  let failed = 0
  // 200+ 插件挂载完成前 canary 的 2s 定时器会被拖慢，属于启动噪声；
  // 等 active 数达到基线的 90% 之后才把心跳间隔计入 T06，之后的中断才算“挂载后卡死”。
  let readyAt = 0
  /** pid -> {firstSeen, cmd}；用于识别“存活过一会、然后被外部杀掉”的工具进程。 */
  const tracked = new Map()
  let all = []
  let lastScan = 0
  let lastLoopAt = Date.now()
  let lastBeatAt = 0
  while (Date.now() - started < seconds * 1000) {
    if (handle.exited) {
      return {
        exited: true,
        test: { status: 'fail', detail: `稳定性观察期间进程退出（exit=${handle.exitCode}）`, evidence: `after ${Math.round((Date.now() - started) / 1000)}s` },
      }
    }
    const now = Date.now()
    const loopDelta = now - lastLoopAt
    lastLoopAt = now
    // 全量进程表每 3s 取一次；后代在 JS 里算，避免逐层 powershell 拖慢心跳。
    if (now - lastScan >= 3000) {
      all = listProcesses()
      lastScan = now
    }
    const children = all.length ? descendantsOf(all, handle.pid) : []
    const alive = new Set(children.map((c) => c.pid))
    for (const c of children) if (!tracked.has(c.pid)) tracked.set(c.pid, { firstSeen: now, cmd: c.cmd })
    for (const [pid, info] of tracked) {
      if (alive.has(pid)) continue
      const age = now - info.firstSeen
      // 短暂子进程（pnpm/git 等启动期工具）不算；存活 ≥6s 后消失 = 很可能是用户强杀
      if (age >= 6000) {
        return {
          externalKill: { pid, command: info.cmd, livedMs: age },
          test: {
            status: 'pass',
            detail: `检测到工具进程被外部结束（pid ${pid}，存活 ${Math.round(age / 1000)}s），已暂停，未自动重启`,
          },
        }
      }
      tracked.delete(pid)
    }
    const canary = readCanary(run)
    if (canary) {
      failed = Math.max(failed, canary.counts.failed || 0)
      const need = expectedActive > 0 ? Math.max(1, Math.floor(expectedActive * 0.9)) : 1
      if (!readyAt && (canary.counts.active || 0) >= need) readyAt = now
      // 用心跳文件自己的 updatedAt 计算间隔，避免把扫描进程（powershell 全量进程表）
      // 或 gate 自身事件循环的耗时误判成插件卡死。
      const beatAt = Date.parse(canary.updatedAt || 0)
      if (Number.isFinite(beatAt) && beatAt > 0) {
        if (readyAt && now - readyAt >= 5000) {
          // 相邻两次心跳的时间差：gate 卡住时这个值仍然真实。
          if (lastBeatAt > 0 && beatAt > lastBeatAt) maxGap = Math.max(maxGap, beatAt - lastBeatAt)
          // gate 本轮没有被卡住时，才用“心跳距今多久”兜底检测彻底停写。
          if (loopDelta <= 4000) {
            const age = now - beatAt
            if (age > 0) maxGap = Math.max(maxGap, age)
          }
        }
        lastBeatAt = beatAt
      }
    }
    await sleep(2000)
  }
  if (failed > 0) return { test: { status: 'fail', detail: `稳定性期间出现 ${failed} 个 failed` } }
  if (maxGap > 20000)
    return {
      test: {
        status: 'fail',
        detail: `canary 心跳中断 ${maxGap}ms（>20000ms；正常冷启动末段会有一次约 12s 的挂载收尾停顿，属已知基线行为）`,
      },
    }
  return {
    test: {
      status: 'pass',
      detail: `观察 ${seconds}s，挂载完成后心跳正常（max gap ${maxGap}ms），无 failed`,
    },
  }
}

const NOISE_RE = /(Error:|FAILED|failed to activate|did not activate|ENOENT|EBUSY|EACCES)/i
const KNOWN_NOISE = [/EBUSY.*ntuser\.dat/i, /hmr \(@deepseek-ai\/dsh-hmr\)/i]

/** 把 file:// 入口映射成包名，保证不同 run 目录之间的基线可比。 */
export function normalizeEntryName(name) {
  if (!name) return name
  if (!String(name).startsWith('file:')) return name
  let file = name
  try {
    file = decodeURIComponent(name)
  } catch {
    /* keep raw */
  }
  const normalized = file.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/node_modules/')
  if (idx < 0) return name
  const parts = normalized.slice(idx + '/node_modules/'.length).split('/')
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
}

function scanLogNoise(handle, baselineNoise) {
  const text = (handle.stdout || '') + '\n' + (handle.stderr || '')
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => NOISE_RE.test(l))
    .filter((l) => !KNOWN_NOISE.some((re) => re.test(l)))
  const baseline = new Set((baselineNoise && baselineNoise.lines) || [])
  const newErrors = lines.filter((l) => !baseline.has(l))
  return { lines, newErrors, baselineLines: baseline.size }
}

export function aggregateTests(boots, extra = {}) {
  const tests = {}
  const all = boots.flatMap((b) => Object.entries(b.tests || {}))
  for (const [id, result] of all) {
    if (!tests[id] || result.status === 'fail') tests[id] = result
  }
  for (const [id, result] of Object.entries(extra)) tests[id] = result
  return tests
}

function trim(text, n = 800) {
  return String(text || '').slice(-n)
}

export function failedItems(tests) {
  return Object.entries(tests)
    .filter(([, t]) => t.status === 'fail')
    .map(([id, t]) => ({ id, name: t.name || ID_NAMES[id] || id, detail: t.detail || '', evidence: t.evidence || '' }))
}

const ID_NAMES = {
  T01: '重启/启动是否成功',
  T02: '冷重启重复性',
  T03: 'session 是否正常',
  T04: '其他插件是否崩溃',
  T05: '候选插件是否挂载',
  T06: '稳定性/心跳',
  T07: 'session 读写冒烟',
  T08: '主机隔离',
  T09: '回退完整性',
  T10: '插件冲突',
  T11: '硬件门控',
  T12: '外部中断处理',
  T13: '断点续跑',
  T14: '备份完整性',
  T15: '启动时延（半成品阻塞）',
  T16: '装进 live 沙盒列表并启动验证',
  T17: '功能检查',
}

export function writeReport(paths, run, payload) {
  const dir = paths.evidenceDir(run.runId)
  ensureDir(dir)
  const report = {
    version: 1,
    runId: run.runId,
    createdAt: nowIso(),
    candidate: run.candidate,
    coreVersion: run.coreVersion,
    baselineFingerprint: run.baselineFingerprint,
    ...payload,
  }
  writeJsonAtomic(path.join(dir, 'report.json'), report)
  writeTextAtomic(path.join(dir, 'report.md'), renderReport(report))
  writeJsonAtomic(paths.gateFile, {
    lastRunId: run.runId,
    verdict: report.verdict,
    at: report.createdAt,
    candidate: run.candidate,
    reportPath: path.join(dir, 'report.json'),
  })
  return report
}

export function renderReport(report) {
  const lines = [
    `# 沙盒校验报告 ${report.runId}`,
    '',
    `- 候选：${report.candidate?.packageName || report.candidate?.name || '基线自检'} ${report.candidate?.version || ''}`,
    `- 结论：**${report.verdict}**`,
    `- 核心：${report.coreVersion}`,
    `- 主机未被修改：${report.hostUnchanged ? '是' : '否/未知'}`,
    `- 回退：${report.rollback?.performed ? '已丢弃运行副本' : report.rollback?.reason || '无'}`,
    '',
    '## 测试项',
    '',
    '| 测试 | 结果 | 说明 |',
    '|---|---|---|',
  ]
  for (const [id, t] of Object.entries(report.tests || {})) {
    lines.push(`| ${id} ${ID_NAMES[id] || ''} | ${t.status} | ${String(t.detail || '').replace(/\|/g, '/').slice(0, 300)} |`)
  }
  if (report.failedItems?.length) {
    lines.push('', '## 失败项', '')
    for (const item of report.failedItems) lines.push(`- **${item.id}** ${item.name}：${item.detail}`)
  }
  lines.push('', `报告目录：${report.evidenceDir || ''}`, '')
  return lines.join('\n')
}

/** T09：回退后重新启动基线，证明沙盒仍可用。 */
export async function baselineSelfCheck(paths, config, manifest, log = () => {}) {
  const run = createRun(paths, config, manifest, { candidate: null, restartCycles: 0, stabilitySec: 8 })
  let result
  try {
    run.port = await pickPort(config)
    result = await bootOnce(paths, config, run, { observeSec: 8, requireCandidate: false })
  } finally {
    await stopDsh(result?.handle)
    disposeRun(paths, run)
  }
  const failed = Object.entries(result.tests || {}).filter(([, t]) => t.status === 'fail')
  // 自检只关心“基线还能启动、session 未坏、原插件仍在”，
  // 心跳抖动/日志噪声在负载高的机器上会误报，不作为回退完整性的判据。
  const fatal = failed.filter(([id]) => ['T01', 'T03', 'T04'].includes(id))
  return {
    test: {
      status: fatal.length ? 'fail' : 'pass',
      detail: fatal.length
        ? `基线启动失败：${fatal.map(([id, t]) => `${id} ${t.detail}`).join('；')}`
        : '基线在回退后仍可启动，canary 全部 active',
    },
  }
}

export function hostUnchanged(before, after) {
  const profileStable = before.fingerprint === after.fingerprint && before.profileHash === after.profileHash
  // guiPid 依赖 netstat 解析，偶尔拿不到（null）；只有前后都拿到且不同才算主机被动过。
  const pidChanged = Boolean(before.guiPid && after.guiPid && before.guiPid !== after.guiPid)
  return {
    ok: profileStable && !pidChanged,
    profileStable,
    pidChanged,
    pidUnobserved: Boolean(before.guiPid && !after.guiPid),
    before,
    after,
  }
}

export function normalizeCandidate(args, audit) {
  return {
    spec: args.spec || (args.path ? args.path : null),
    localPath: args.path || null,
    name: audit?.name || null,
    version: audit?.version || null,
    auditVerdict: audit?.verdict || null,
    packageName: audit?.name || null,
    source: args.path ? 'local' : 'registry',
  }
}

export async function gpuGate(config, options = {}) {
  if (!config.gpu.enabled) return { ok: true, skipped: true, reason: 'gpu-disabled' }
  const sample = await sampleIdle(config.gpu)
  if (sample.idle) return { ok: true, sample, skipped: sample.reason === 'gpu-unknown' }
  if (options.waitSec > 0) {
    const waited = await waitForIdle(config.gpu, options.waitSec, 15)
    return { ok: waited.idle, sample, waited }
  }
  return { ok: false, reason: 'gpu-busy', sample }
}

export async function runInstallTest(paths, config, args = {}) {
  paths.ensureLayout()
  const log = args.log || (() => {})
  const lock = acquireLock(paths, 'install-test')
  if (!lock.ok) return { status: 'busy', ...lock }
  const started = Date.now()
  let run = null
  try {
    const inventory = cachedInventory(paths, config, { force: args.forceCalibrate }).inventory
    const backup = ensureBackup(paths, config)
    if (!backup.ok) return { status: 'blocked', reason: 'backup-invalid', detail: backup }

    const audit = auditCandidate(paths, config, { path: args.path, spec: args.spec, log })
    const allowed = auditVerdictForInstall(audit, args.force)
    if (!allowed.allowed) {
      const pseudo = { runId: 'audit-' + Date.now(), candidate: { name: audit.name, version: audit.version }, coreVersion: inventory.host.coreVersion, baselineFingerprint: null }
      const report = writeReport(paths, pseudo, {
        verdict: 'blocked',
        reason: allowed.reason,
        audit,
        tests: { T10: { status: 'fail', detail: allowed.reason } },
        failedItems: [{ id: 'AUDIT', name: '静态审计', detail: allowed.reason }],
        hostUnchanged: true,
        rollback: { performed: false, reason: '未创建运行副本' },
      })
      return { status: 'blocked', audit, reportPath: path.join(paths.evidenceDir(pseudo.runId), 'report.json'), verdict: 'blocked' }
    }

    // 只有确实依赖显卡的插件才做硬件门控；普通插件不打扰用户。
    const needsGpu = args.requireGpu === true || audit.gpuLikely?.likely === true
    const gpu = needsGpu
      ? await gpuGate(config, { waitSec: args.gpuWaitSec || 0 })
      : { ok: true, skipped: true, reason: 'not-gpu-plugin' }
    if (!gpu.ok) {
      return {
        status: 'blocked_gpu',
        reason: 'GPU 正忙，暂不启动插件测试（避免影响用户使用显卡）',
        gpu: gpu.sample,
        options: ['等待后重试 sandbox_gate_hardware({waitSec})', '或用户确认后继续'],
      }
    }

    const baseline = await ensureBaseline(paths, config, inventory, { force: args.forceBaseline }, log)
    if (!baseline.ok) return { status: 'blocked', reason: 'baseline-failed', detail: baseline }
    const manifest = baseline.manifest

    const hostBefore = hostSnapshot(config)
    run = createRun(paths, config, manifest, {
      candidate: normalizeCandidate(args, audit),
      restartCycles: args.restartCycles ?? config.restartCycles,
      stabilitySec: args.stabilitySec ?? config.stabilitySec,
      allowInstallScripts: Boolean(args.allowInstallScripts),
    })
    run.port = await pickPort(config)
    run.stage = 'installing'
    saveRun(paths, run)
    saveCheckpoint(paths, {
      runId: run.runId,
      stage: 'install',
      candidate: run.candidate,
      baselineFingerprint: manifest.fingerprint,
      results: {},
    })

    const installed = stageCandidate(paths, config, run, { ...run.candidate, name: audit.name, spec: args.spec }, log)
    if (!installed.ok) {
      const tests = { T05: { status: 'fail', detail: installed.error || '候选安装失败' } }
      const rollback = { performed: true, reason: '安装失败，丢弃运行副本' }
      disposeRun(paths, run)
      const before = hostBefore
      const after = hostSnapshot(config)
      const hu = hostUnchanged(before, after)
      const report = writeReport(paths, run, {
        verdict: 'fail',
        tests,
        failedItems: failedItems(tests),
        install: { ok: false, error: installed.error, log: trim([installed.log?.stderr, installed.log?.stdout, installed.log?.error].filter(Boolean).join('\n')).slice(-4000) },
        hostUnchanged: hu.ok,
        host: hu,
        rollback,
        durationMs: Date.now() - started,
        evidenceDir: paths.evidenceDir(run.runId),
      })
      return { status: 'fail', verdict: 'fail', runId: run.runId, tests, failedItems: failedItems(tests), reportPath: path.join(paths.evidenceDir(run.runId), 'report.json'), rollback }
    }

    run.candidate = { ...run.candidate, ...installed, packageName: installed.packageName, version: installed.version }
    run.stage = 'installed'
    saveRun(paths, run)
    saveCheckpoint(paths, {
      runId: run.runId,
      stage: 'installed',
      candidate: run.candidate,
      baselineFingerprint: manifest.fingerprint,
      results: {},
    })

    const boots = []
    let interrupted = null
    const cycles = run.options.restartCycles
    for (let i = 0; i <= cycles; i++) {
      const first = i === 0
      log(`第 ${i + 1} 次启动${first ? '' : '（冷重启）'}`)
      run.stage = first ? 'boot1' : `restart${i}`
      saveRun(paths, run)
      const result = await bootOnce(paths, config, run, {
        observeSec: first ? run.options.stabilitySec : Math.min(15, run.options.stabilitySec),
        requireCandidate: true,
      })
      boots.push({ index: i, ...result })
      saveCheckpoint(paths, {
        runId: run.runId,
        stage: run.stage,
        candidate: run.candidate,
        baselineFingerprint: manifest.fingerprint,
        results: aggregateTests(boots),
        artifacts: [paths.evidenceDir(run.runId)],
      })
      if (result.interrupted) {
        interrupted = result
        break
      }
      if (result.tests?.T01?.status !== 'pass') break
    }

    if (interrupted) {
      // 沙盒仍在跑时被外部打断（工具进程被杀）：由网关主动收掉进程，避免和用户对抗。
      try {
        if (interrupted.handle && !interrupted.handle.exited) await stopDsh(interrupted.handle)
      } catch {
        /* 已退出 */
      }
      const interrupt = writeInterrupt(paths, {
        runId: run.runId,
        stage: run.stage,
        candidate: {
          name: run.candidate.packageName,
          summary: `正在沙盒中测试插件 ${run.candidate.packageName}（核心 ${run.coreVersion}）`,
        },
        reason: interrupted.externalKill ? 'external-kill-tool-process' : 'external-exit',
        toolProcess: interrupted.externalKill || null,
        options: INTERRUPT_OPTIONS.map((o) => o.id),
        detectedAt: nowIso(),
        pid: run.pid,
        exitCode: interrupted.handle?.exitCode ?? null,
        detail: interrupted.tests.T01?.detail || interrupted.tests.T06?.detail || '',
      })
      run.stage = 'interrupted'
      saveRun(paths, run)
      return {
        status: 'interrupted',
        verdict: 'interrupted',
        runId: run.runId,
        interrupt,
        tests: interrupted.tests,
        hint: '用户强杀/退出后不会自动重启。请询问用户四选一，再调用 sandbox_gate_interrupt。',
      }
    }

    const tests = aggregateTests(boots)
    if (boots.length > 1) {
      const bootPass = (b) => b.tests?.T01?.status === 'pass'
      tests.T02 = {
        status: boots.every(bootPass) ? 'pass' : 'fail',
        detail: `冷重启 ${boots.length - 1} 次，${boots.filter(bootPass).length}/${boots.length} 次启动通过（T02 只看启动本身；启动后的稳定性由 T06 单独判定）`,
      }
    } else {
      tests.T02 = { status: 'fail', detail: '未完成冷重启（首次启动失败或提前中断）' }
    }
    // 至少一次候选 active
    const candidateOk = boots.some((b) => b.tests.T05?.status === 'pass')
    tests.T05 = candidateOk
      ? { status: 'pass', detail: run.candidate.packageName + ' 在 canary 中 active' }
      : boots.find((b) => b.tests.T05)?.tests.T05 || { status: 'fail', detail: '候选未挂载' }

    // 需要“装进沙盒列表”时，测试通过后把候选装进 live profile，并启动 live 沙盒验证。
    let live = null
    if (args.installLive) {
      if (!audit.dir) {
        tests.T16 = { status: 'fail', detail: '候选源码目录不可用，无法安装到 live 沙盒' }
      } else {
        const info = await installIntoLive(paths, config, {
          packageName: installed.packageName,
          source: audit.dir,
          log,
        })
        if (!info.ok) {
          tests.T16 = { status: 'fail', detail: info.detail || 'live 安装失败' }
          live = { ok: false, ...info }
        } else {
          const boot = await verifyLiveBoot(paths, config, {
            packageName: installed.packageName,
            runId: run.runId,
            log,
          })
          let functional = { ok: true, skipped: true, detail: '未提供功能检查命令' }
          if (boot.ok && args.functionalCommand) {
            functional = runFunctionalCommand(args.functionalCommand, config.sandboxRoot)
          }
          if (!boot.ok || !functional.ok) {
            await rollbackLiveInstall(paths, config, info)
            tests.T16 = {
              status: 'fail',
              detail: `${boot.ok ? '' : boot.detail}${functional.ok ? '' : (boot.ok ? '' : '；') + functional.detail}`,
            }
            live = { ok: false, installed: info, boot, functional, rolledBack: true }
          } else {
            tests.T16 = {
              status: 'pass',
              detail: `${installed.packageName} 已安装进 live 沙盒，启动后 entry active，无 failed`,
            }
            live = { ok: true, installed: info, boot: { ok: true, port: boot.port, url: boot.url }, functional }
          }
          if (args.functionalCommand) {
            tests.T17 = { status: functional.ok ? 'pass' : 'fail', detail: functional.detail }
          }
        }
      }
    }

    const allOk = tests.T02.status === 'pass' && (!args.installLive || tests.T16?.status === 'pass')
    const rollback = { performed: true, reason: '测试完成，丢弃一次性运行副本' }
    disposeRun(paths, run)

    const selfCheck = await baselineSelfCheck(paths, config, manifest, log)
    tests.T09 = selfCheck.test
    if (!allOk) tests.T09 = { ...tests.T09, detail: tests.T09.detail + '（失败项已隔离，基线可用）' }

    const hostAfter = hostSnapshot(config)
    const hu = hostUnchanged(hostBefore, hostAfter)
    tests.T08 = {
      status: hu.ok ? 'pass' : 'fail',
      detail: hu.ok ? '主机 profile 哈希与 GUI 进程未变化' : '主机状态发生变化！',
    }
    tests.T10 = {
      status: (audit.findings || []).some((f) => f.id === 'A10') ? 'fail' : 'pass',
      detail: (audit.findings || []).some((f) => f.id === 'A10') ? '候选与基线存在 id/name 冲突' : '未发现与基线的 entry 冲突',
    }
    tests.T14 = { status: backup.ok ? 'pass' : 'fail', detail: backup.ok ? '便携发行备份校验通过' : '备份校验失败' }
    tests.T11 = {
      status: gpu.skipped ? 'skip' : 'pass',
      detail: gpu.skipped ? 'GPU 不可用/未启用，硬件门控跳过' : `GPU 空闲，util ${gpu.sample?.samples?.[0]?.util ?? '?'}%`,
    }
    tests.T07 = { status: 'skip', detail: '未配置模型凭据，session 读写冒烟跳过（T03 已做静态完整性）' }

    const requiredIds = args.installLive ? [...REQUIRED, 'T16'] : REQUIRED
    const requiredFails = requiredIds.filter((id) => tests[id] && tests[id].status === 'fail')
    const verdict = requiredFails.length ? 'fail' : 'pass'
    const report = writeReport(paths, run, {
      verdict,
      tests,
      failedItems: failedItems(tests),
      audit,
      live,
      install: { ok: true, packageName: installed.packageName, needsBundle: installed.needsBundle },
      boots: boots.map((b) => ({ index: b.index, ok: b.ok, tests: b.tests })),
      gpu: gpu.sample,
      hostUnchanged: hu.ok,
      host: hu,
      rollback,
      baselineSelfCheck: tests.T09,
      durationMs: Date.now() - started,
      evidenceDir: paths.evidenceDir(run.runId),
    })
    if (verdict === 'pass') {
      writeReceipt(paths, {
        verdict: 'pass',
        packageName: installed.packageName,
        version: installed.version,
        spec: run.candidate?.spec || run.candidate?.path || installed.packageName,
        kind: run.candidate?.kind || 'spec',
        contentHash: audit.contentHash,
        runId: run.runId,
        coreVersion: config.coreVersion,
      })
    }
    return {
      status: verdict,
      verdict,
      runId: run.runId,
      candidate: run.candidate,
      tests,
      failedItems: failedItems(tests),
      rollback,
      reportPath: path.join(paths.evidenceDir(run.runId), 'report.json'),
    }
  } catch (error) {
    return { status: 'error', error: String(error.message || error), runId: run?.runId || null }
  } finally {
    releaseLock(paths)
  }
}

/** 对已有 run 做重启测试。 */
export async function runRestartTest(paths, config, args = {}) {
  const run = loadRun(paths, args.runId)
  if (!run || run.stage === 'disposed') return { status: 'error', error: 'run 不存在或已回退' }
  const lock = acquireLock(paths, 'restart-test')
  if (!lock.ok) return { status: 'busy', ...lock }
  const boots = []
  try {
    const cycles = args.cycles ?? 1
    for (let i = 0; i < cycles; i++) {
      run.port = await pickPort(config)
      const result = await bootOnce(paths, config, run, { observeSec: 10, requireCandidate: true })
      boots.push(result)
      if (result.interrupted) {
        const interrupt = writeInterrupt(paths, {
          runId: run.runId,
          stage: 'restart-test',
          candidate: { name: run.candidate?.packageName, summary: `重启测试 ${run.candidate?.packageName}` },
          reason: 'external-exit',
          detectedAt: nowIso(),
          pid: run.pid,
        })
        return { status: 'interrupted', runId: run.runId, interrupt, tests: result.tests }
      }
      if (result.tests?.T01?.status !== 'pass') break
    }
    const tests = aggregateTests(boots)
    const bootPass = (b) => b.tests?.T01?.status === 'pass'
    tests.T02 = { status: boots.every(bootPass) ? 'pass' : 'fail', detail: `${boots.filter(bootPass).length}/${boots.length} 次重启通过（只看启动，稳定性见 T06）` }
    return { status: boots.every(bootPass) ? 'pass' : 'fail', runId: run.runId, tests }
  } finally {
    releaseLock(paths)
  }
}
