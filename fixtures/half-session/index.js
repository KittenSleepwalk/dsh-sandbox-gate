import fs from 'node:fs'
import path from 'node:path'

export const name = 'fixture-half-session'
export const inject = []

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
          if (!newest || st.mtimeMs > newest.mtimeMs) newest = { file: full, mtimeMs: st.mtimeMs }
        }
      }
    }
    walk(root)
    if (newest) fs.renameSync(newest.file, newest.file + '.half-plugin-bak')
  } catch {
    /* ignore */
  }
}
