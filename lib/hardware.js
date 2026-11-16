import { exec, sleep, nowIso } from './util.js'

/** 采样一次 GPU：util / 显存 / 占用进程。无 nvidia-smi 时返回 available:false。 */
export function sampleGpu() {
  const query = exec(
    'nvidia-smi',
    ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
    { timeout: 15000 },
  )
  if (!query.ok || !query.stdout.trim()) {
    return { available: false, error: query.error || query.stderr.trim() || 'nvidia-smi 不可用', at: nowIso() }
  }
  const first = query.stdout.trim().split(/\r?\n/)[0]
  const parts = first.split(',').map((s) => s.trim())
  const util = Number(parts[0])
  const usedMb = Number(parts[1])
  const totalMb = Number(parts[2])
  const proc = exec(
    'nvidia-smi',
    ['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader,nounits'],
    { timeout: 15000 },
  )
  const processes = proc.ok
    ? proc.stdout
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [pid, name, mem] = line.split(',').map((s) => s.trim())
          return { pid: Number(pid), name, usedMb: Number(mem) }
        })
    : []
  return {
    available: true,
    util,
    usedMb,
    totalMb,
    memPct: totalMb ? (usedMb / totalMb) * 100 : 0,
    processes,
    at: nowIso(),
  }
}

export function isIdle(sample, gpuConfig) {
  if (!sample.available) return { idle: true, reason: 'gpu-unknown' }
  const idle = sample.util <= gpuConfig.utilMax && sample.memPct <= gpuConfig.memMaxPct
  return {
    idle,
    reason: idle ? 'idle' : 'busy',
    detail: `util ${sample.util}% (≤${gpuConfig.utilMax}), mem ${sample.usedMb}/${sample.totalMb}MB (${sample.memPct.toFixed(0)}% ≤${gpuConfig.memMaxPct}%)`,
  }
}

/** 连续采样，全部 idle 才返回 idle:true。 */
export async function sampleIdle(gpuConfig, options = {}) {
  const samples = Math.max(1, options.samples ?? gpuConfig.samples)
  const intervalMs = options.intervalMs ?? gpuConfig.intervalMs
  const rows = []
  for (let i = 0; i < samples; i++) {
    const sample = sampleGpu()
    rows.push(sample)
    if (!sample.available) return { idle: true, reason: 'gpu-unknown', samples: rows }
    const judgement = isIdle(sample, gpuConfig)
    if (!judgement.idle) return { idle: false, reason: judgement.reason, detail: judgement.detail, samples: rows }
    if (i < samples - 1) await sleep(intervalMs)
  }
  return { idle: true, reason: 'idle', samples: rows }
}

/** 轮询等待空闲，最多 waitSec 秒。 */
export async function waitForIdle(gpuConfig, waitSec = 300, intervalSec = 15) {
  const deadline = Date.now() + waitSec * 1000
  const attempts = []
  while (Date.now() < deadline) {
    const result = await sampleIdle(gpuConfig)
    attempts.push({ at: nowIso(), idle: result.idle, reason: result.reason, detail: result.detail })
    if (result.idle) return { idle: true, waitedMs: waitSec * 1000 - (deadline - Date.now()), attempts }
    await sleep(intervalSec * 1000)
  }
  return { idle: false, waitedMs: waitSec * 1000, attempts, error: '等待超时，显卡仍忙' }
}
