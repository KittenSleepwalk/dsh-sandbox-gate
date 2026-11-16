import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { ensureDir, isAlive, readJson, sleep, stripAnsi, writeTextAtomic, nowIso } from './util.js'
import { FORBIDDEN_PORTS } from './config.js'

export function buildEnv(run, config) {
  const root = run.root
  const nodeDir = path.join(root, 'runtimes', 'windows-x64', 'node')
  const shimDir = path.join(root, 'runtimes', 'windows-x64', 'bin')
  const home = path.join(root, 'data', 'portable-home')
  const temp = path.join(root, 'temp')
  ensureDir(home)
  ensureDir(temp)
  const pathParts = [nodeDir, shimDir, process.env.Path || process.env.PATH || '']
  return {
    ...process.env,
    PATH: pathParts.join(';'),
    Path: pathParts.join(';'),
    DSH_HOME: path.join(root, 'data', 'dsh-home'),
    DSH_AGENTS_HOME: path.join(root, 'data', 'agents-home'),
    USERPROFILE: home,
    HOME: home,
    TEMP: temp,
    TMP: temp,
    DSH_PORTABLE_NO_AUTO_UPDATE: '1',
    DSH_GATE_RUN: run.runId,
    NO_COLOR: '1',
  }
}

export function pickPort(config) {
  const base = config.portBase
  return new Promise((resolve, reject) => {
    let candidate = base
    let tries = 0
    const attempt = () => {
      if (tries++ > 200) return reject(new Error('找不到空闲端口'))
      if (FORBIDDEN_PORTS.includes(candidate)) {
        candidate++
        return attempt()
      }
      const server = net.createServer()
      server.once('error', () => {
        candidate++
        attempt()
      })
      server.once('listening', () => {
        const port = server.address().port
        server.close(() => resolve(port))
      })
      server.listen(candidate, '127.0.0.1')
    }
    attempt()
  })
}

export function launchDsh(run, config, urlValue) {
  const node = path.join(run.root, 'runtimes', 'windows-x64', 'node', 'node.exe')
  const bin = path.join(run.root, 'runtimes', 'windows-x64', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!fs.existsSync(node)) throw new Error(`缺少 node：${node}`)
  if (!fs.existsSync(bin)) throw new Error(`缺少 dsh bin：${bin}`)
  const env = buildEnv(run, config)
  const logDir = path.join(run.root, '.sandbox-gate')
  ensureDir(logDir)
  const bootLog = path.join(logDir, 'boot.log')
  const fd = fs.openSync(bootLog, 'a')
  const extraArgs = Array.isArray(run.extraArgs) ? run.extraArgs : []
  const child = spawn(node, [bin, '--profile', run.profile, ...extraArgs, '--port', String(run.port), '--no-open'], {
    cwd: run.root,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const handle = {
    pid: child.pid,
    child,
    bootLog,
    url: urlValue ? urlValue() : null,
    token: null,
    exited: false,
    exitCode: null,
    killedByGate: false,
    stdout: '',
    stderr: '',
    startedAt: nowIso(),
  }
  const onData = (stream, isErr) => (buf) => {
    const text = stripAnsi(buf.toString('utf8'))
    if (isErr) handle.stderr += text
    else handle.stdout += text
    fs.writeSync(fd, text)
    const m = text.match(/dsh web: (http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+))/)
    if (m && !handle.url) {
      handle.url = m[1]
      handle.portFromUrl = Number(m[2])
      handle.token = m[3]
    }
  }
  child.stdout.on('data', onData(child.stdout, false))
  child.stderr.on('data', onData(child.stderr, true))
  handle.exit = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      handle.exited = true
      handle.exitCode = code
      handle.exitSignal = signal
      fs.closeSync(fd)
      resolve({ code, signal, killedByGate: handle.killedByGate })
    })
  })
  return handle
}

export function killTree(pid) {
  if (!pid) return
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } catch {
    /* ignore */
  }
}

export async function waitForBoot(handle, timeoutSec = 90) {
  const deadline = Date.now() + timeoutSec * 1000
  while (Date.now() < deadline) {
    if (handle.url) return { ok: true, url: handle.url, port: handle.portFromUrl, token: handle.token }
    if (handle.exited) return { ok: false, reason: 'exited', exitCode: handle.exitCode, stderr: handle.stderr.slice(-3000) }
    await sleep(500)
  }
  return { ok: false, reason: 'timeout', stderr: handle.stderr.slice(-3000), stdout: handle.stdout.slice(-2000) }
}

export function httpStatus(url, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let bytes = 0
      res.on('data', (chunk) => (bytes += chunk.length))
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode, bytes }))
    })
    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false, error: 'timeout' })
    })
    req.on('error', (error) => resolve({ ok: false, error: String(error.message || error) }))
  })
}

export function canaryPath(run) {
  return path.join(run.root, '.sandbox-gate', 'canary-out', 'status.json')
}

export function readCanary(run) {
  const status = readJson(canaryPath(run))
  if (!status) return null
  const ageMs = Date.now() - new Date(status.updatedAt).getTime()
  return { ...status, ageMs, fresh: ageMs <= 10000 }
}

export async function waitForCanary(run, timeoutSec = 40, requirePid = true) {
  const deadline = Date.now() + timeoutSec * 1000
  while (Date.now() < deadline) {
    const status = readCanary(run)
    if (status && (!requirePid || status.pid === run.pid || status.fresh)) return { ok: true, status }
    await sleep(1000)
  }
  return { ok: false, error: 'canary 未在超时内产出 status.json' }
}

export async function waitForExit(handle, timeoutSec = 20) {
  const result = await Promise.race([handle.exit, sleep(timeoutSec * 1000).then(() => ({ timeout: true }))])
  return result
}

export async function stopDsh(handle, timeoutSec = 15) {
  if (!handle) return { ok: true }
  if (handle.exited) return { ok: true, alreadyExited: true, exitCode: handle.exitCode }
  handle.killedByGate = true
  killTree(handle.pid)
  const result = await waitForExit(handle, timeoutSec)
  if (result.timeout && isAlive(handle.pid)) {
    killTree(handle.pid)
    await waitForExit(handle, 5)
  }
  return { ok: true, exitCode: handle.exitCode, timeout: Boolean(result.timeout) }
}

/** 记录进程树里与 run 相关的 pid（用于外部中断判定）。 */
export function processSnapshot(pid) {
  return { pid, at: nowIso(), alive: isAlive(pid) }
}

export function appendRunLog(run, text) {
  const file = path.join(run.root, '.sandbox-gate', 'gate.log')
  ensureDir(path.dirname(file))
  fs.appendFileSync(file, `[${nowIso()}] ${text}\n`)
}
