import path from 'node:path'
import fs from 'node:fs'

/**
 * 所有运行期写入都必须经过这里。
 * 规则：只允许 sandboxRoot 之内；显式拒绝 host dshHome / host profile；
 * 删除 junction 时只删链接本身（本类不递归进入 junction）。
 */
export class GatePaths {
  constructor(config) {
    this.config = config
    this.root = path.resolve(config.sandboxRoot)
    this.gate = path.join(this.root, '.sandbox-gate')
    this.state = path.join(this.gate, 'state')
    this.logs = path.join(this.gate, 'logs')
    this.runs = path.join(this.gate, 'runs')
    this.evidence = path.join(this.gate, 'evidence')
    this.core = path.join(this.gate, 'core')
    this.baseline = path.join(this.gate, 'baseline')
    this.backup = path.join(this.gate, 'backup')
    this.hostInventory = path.join(this.state, 'host-inventory.json')
    this.baselineManifest = path.join(this.baseline, 'manifest.json')
    this.checkpoint = path.join(this.state, 'checkpoint.json')
    this.interrupt = path.join(this.state, 'interrupt.json')
    this.lock = path.join(this.state, 'gate.lock')
    this.gateFile = path.join(this.state, 'gate.json')
    this.receipts = path.join(this.state, 'receipts.json')
    this.hostInstalls = path.join(this.state, 'host-installs.json')
    this.parityFile = path.join(this.state, 'parity.json')
  }

  coreDir(version) {
    return path.join(this.core, version)
  }

  runDir(id) {
    return path.join(this.runs, id)
  }

  runRoot(id) {
    return path.join(this.runDir(id), 'root')
  }

  evidenceDir(id) {
    return path.join(this.evidence, id)
  }

  check(p, options = {}) {
    const resolved = path.resolve(p)
    const lower = resolved.toLowerCase()
    const rootLower = this.root.toLowerCase()
    const hostHome = path.resolve(this.config.hostDshHome).toLowerCase()
    const hostProfile = path.resolve(this.config.hostProfileDir).toLowerCase()
    if (lower === hostHome || lower.startsWith(hostHome + path.sep.toLowerCase())) {
      throw new Error(`路径守卫拒绝：不得写入主机 DSH home（${resolved}）`)
    }
    if (lower === hostProfile || lower.startsWith(hostProfile + path.sep.toLowerCase())) {
      throw new Error(`路径守卫拒绝：不得写入主机 profile（${resolved}）`)
    }
    if (lower !== rootLower && !lower.startsWith(rootLower + path.sep.toLowerCase())) {
      throw new Error(`路径守卫拒绝：路径不在沙盒内（${resolved}）`)
    }
    if (options.mustBeGate && !lower.startsWith(this.gate.toLowerCase() + path.sep.toLowerCase())) {
      throw new Error(`路径守卫拒绝：运行期写入必须在 .sandbox-gate 内（${resolved}）`)
    }
    return resolved
  }

  ensure(p, options) {
    const resolved = this.check(p, options)
    fs.mkdirSync(resolved, { recursive: true })
    return resolved
  }

  ensureLayout() {
    for (const dir of [this.gate, this.state, this.logs, this.runs, this.evidence, this.core, this.backup]) {
      fs.mkdirSync(dir, { recursive: true })
    }
    return this
  }

  withinRoot(p) {
    const lower = path.resolve(p).toLowerCase()
    const rootLower = this.root.toLowerCase()
    return lower === rootLower || lower.startsWith(rootLower + path.sep.toLowerCase())
  }
}
