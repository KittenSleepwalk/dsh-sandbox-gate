/**
 * dsh-sandbox-canary
 *
 * 目的：不做任何业务，只把当前 loader 里每个插件 entry 的状态写到磁盘。
 * 沙盒校验器据此在没有 LLM、没有 HTTP API 的情况下判断：
 *   - 沙盒是否真的启动成功；
 *   - 基线里的插件在安装候选后是否仍然 active；
 *   - 是否有插件进入 failed；
 *   - 进程是否还在心跳（稳定性观察窗）。
 *
 * 设计约束：
 *   - 绝不抛出异常（任何错误写 error.txt 后吞掉），否则 canary 自己会把沙盒弄崩；
 *   - 不 import 任何 @deepseek-ai/* 包，避免 link/file 安装时的解析问题；
 *   - 只写 config.outDir 指定目录。
 */

import fs from 'node:fs'
import path from 'node:path'

export const name = 'sandbox-canary'

export const inject = ['loader']

const FIBER_PHASE = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: 'disposed',
  5: 'unloading',
}

function safeMkdir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    /* ignore */
  }
}

function atomicWrite(file, text) {
  const tmp = file + '.tmp-' + process.pid
  try {
    fs.writeFileSync(tmp, text)
    fs.renameSync(tmp, file)
  } catch {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
}

function collect(ctx) {
  const rows = []
  try {
    for (const entry of ctx.loader.entries()) {
      const fiber = entry.fiber
      const options = entry.options || {}
      const isGroup = Boolean(entry.subgroup)
      if (!fiber && !isGroup) continue
      const state = fiber ? Number(fiber.state) : null
      rows.push({
        id: options.id != null ? String(options.id) : null,
        name: options.name != null ? String(options.name) : null,
        disabled: Boolean(options.disabled),
        isGroup,
        state,
        phase: state === null ? 'group' : FIBER_PHASE[state] || 'unknown',
        uid: fiber && fiber.uid ? String(fiber.uid) : null,
      })
    }
  } catch (error) {
    return { rows, error: String(error && error.message ? error.message : error) }
  }
  return { rows, error: null }
}

export function apply(ctx, config) {
  const outDir = path.resolve(
    (config && config.outDir) || path.join(process.cwd(), '.sandbox-gate', 'canary'),
  )
  safeMkdir(outDir)
  const bootAt = new Date().toISOString()
  const pid = process.pid
  let timer

  const write = (phase) => {
    const { rows, error } = collect(ctx)
    const failed = rows.filter((r) => r.phase === 'failed')
    const active = rows.filter((r) => r.phase === 'active')
    const payload = {
      plugin: 'dsh-sandbox-canary',
      version: '0.1.0',
      pid,
      bootAt,
      updatedAt: new Date().toISOString(),
      phase,
      outDir,
      counts: {
        total: rows.length,
        active: active.length,
        failed: failed.length,
        pending: rows.filter((r) => r.phase === 'pending').length,
        loading: rows.filter((r) => r.phase === 'loading').length,
        group: rows.filter((r) => r.isGroup).length,
      },
      failed: failed.map((r) => ({ id: r.id, name: r.name, phase: r.phase })),
      rows,
    }
    if (error) payload.collectError = error
    atomicWrite(path.join(outDir, 'status.json'), JSON.stringify(payload, null, 2))
    if (error) atomicWrite(path.join(outDir, 'error.txt'), error + '\n')
  }

  try {
    write('apply')
  } catch {
    /* never crash the sandbox */
  }

  // 启动 3 秒后再写一次（等异步插件完成挂载），之后每 2 秒心跳。
  const lateTimer = setTimeout(() => {
    try {
      write('settled')
    } catch {
      /* ignore */
    }
  }, 3000)
  timer = setInterval(() => {
    try {
      write('heartbeat')
    } catch {
      /* ignore */
    }
  }, 2000)

  const dispose = () => {
    try {
      clearTimeout(lateTimer)
      clearInterval(timer)
    } catch {
      /* ignore */
    }
  }

  try {
    if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'sandbox-canary: timers')
    else dispose()
  } catch {
    /* ignore */
  }
}
