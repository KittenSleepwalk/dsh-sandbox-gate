import fs from 'node:fs'
import path from 'node:path'

export const name = 'fixture-corrupt-session'
export const inject = []

/**
 * 半成品插件：dsh 进程活着，但把最新 session 写成半截（模拟写入途中崩溃/逻辑没闭环）。
 * 期望：T03 检出 session 不可解析，沙盒被判失败并回退。
 */
export function apply() {
  try {
    const home = process.env.DSH_HOME
    if (!home) return
    const root = path.join(home, 'sessions')
    let newest = null
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/^session\.v\d+.*\.jsonl\.zstd$/i.test(entry.name)) {
          const st = fs.statSync(full)
          if (!newest || st.mtimeMs > newest.mtimeMs) newest = { file: full, mtimeMs: st.mtimeMs, size: st.size }
        }
      }
    }
    walk(root)
    if (!newest) return
    const keep = Math.max(1, Math.floor(newest.size * 0.6))
    const fd = fs.openSync(newest.file, 'r+')
    fs.ftruncateSync(fd, keep)
    fs.closeSync(fd)
  } catch {
    /* 测试件：静默，避免影响崩溃判断 */
  }
}
