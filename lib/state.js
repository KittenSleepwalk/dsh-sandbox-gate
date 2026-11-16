import fs from 'node:fs'
import path from 'node:path'
import { readJson, writeJsonAtomic, nowIso, isAlive } from './util.js'

export const INTERRUPT_OPTIONS = [
  { id: 'continue', label: '继续工具测试', desc: '我知道当前测试的工具是什么，允许继续（手动恢复）' },
  { id: 'disallow_tool', label: '不允许当前工具使用', desc: '跳过需要该硬件的工具，继续其余测试' },
  { id: 'suspend', label: '挂起工具测试', desc: '等硬件空闲后自动/手动恢复（agent 轮询进程与 GPU）' },
  { id: 'stop', label: '彻底停止插件设计', desc: '保存断点并回退沙盒，主机不受影响' },
]

export function writeInterrupt(paths, payload) {
  const data = { version: 1, createdAt: nowIso(), options: INTERRUPT_OPTIONS, ...payload }
  writeJsonAtomic(paths.interrupt, data)
  return data
}

export function readInterrupt(paths) {
  return readJson(paths.interrupt)
}

export function clearInterrupt(paths) {
  if (fs.existsSync(paths.interrupt)) fs.unlinkSync(paths.interrupt)
}

export function saveCheckpoint(paths, payload) {
  const data = { version: 1, savedAt: nowIso(), ...payload }
  writeJsonAtomic(paths.checkpoint, data)
  return data
}

export function readCheckpoint(paths) {
  return readJson(paths.checkpoint)
}

/** 通过 install_test 的凭证：主机安装的唯一依据。 */
export function readReceipts(paths) {
  const data = readJson(paths.receipts)
  return Array.isArray(data?.receipts) ? data.receipts : []
}

export function writeReceipt(paths, receipt) {
  const all = readReceipts(paths).filter(
    (r) => !(r.packageName === receipt.packageName && r.version === receipt.version),
  )
  all.unshift({ ...receipt, recordedAt: nowIso() })
  writeJsonAtomic(paths.receipts, { version: 1, receipts: all.slice(0, 100) })
  return receipt
}

export function findReceipt(paths, { packageName, version } = {}) {
  if (!packageName) return undefined
  return readReceipts(paths).find(
    (r) => r.verdict === 'pass' && r.packageName === packageName && (!version || r.version === version),
  )
}

export function readHostInstalls(paths) {
  const data = readJson(paths.hostInstalls)
  return Array.isArray(data?.installs) ? data.installs : []
}

export function appendHostInstall(paths, entry) {
  const all = readHostInstalls(paths)
  all.unshift({ ...entry, at: nowIso() })
  writeJsonAtomic(paths.hostInstalls, { version: 1, installs: all.slice(0, 50) })
  return entry
}

export function acquireLock(paths, owner = 'gate') {
  const existing = readJson(paths.lock)
  if (existing && existing.pid && isAlive(existing.pid) && Date.now() - new Date(existing.at).getTime() < 30 * 60 * 1000) {
    return { ok: false, error: `已有运行中的 gate 进程（pid ${existing.pid}，${existing.at}）`, lock: existing }
  }
  const lock = { pid: process.pid, owner, at: nowIso() }
  writeJsonAtomic(paths.lock, lock)
  return { ok: true, lock }
}

export function releaseLock(paths) {
  try {
    if (fs.existsSync(paths.lock)) fs.unlinkSync(paths.lock)
  } catch {
    /* ignore */
  }
}
