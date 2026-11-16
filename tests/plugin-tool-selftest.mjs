/**
 * 在“拟主机 dsh”的 Node 环境里模拟一次工具调用：
 * 验证工具注册、返回 JSON 可序列化、状态/同步/守卫三条链路可用。
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'

const sandboxRoot = process.env.GATE_SANDBOX_ROOT || path.join(os.homedir(), 'DSH-SandBox')
const tools = new Map()
const guards = []
const ctx = {
  tools: {
    register(def) {
      tools.set(def.name, def)
    },
    guard(fn) {
      guards.push(fn)
      return () => {}
    },
  },
  effect(fn) {
    fn()
  },
  reflect: { get: () => null },
  get: () => null,
  inject: () => {},
}

apply(ctx, { sandboxRoot })

assert.equal(tools.size, 15, `expected 15 tools, got ${tools.size}`)
assert.equal(guards.length, 1, 'install guard not registered')

function serialize(value, label) {
  const text = JSON.stringify(value)
  assert.equal(typeof text, 'string', `${label} not serializable`)
  return JSON.parse(text)
}

for (const [name, def] of tools) {
  assert.equal(typeof def.execute, 'function', `${name} missing execute`)
  assert.equal(typeof def.output?.render, 'function', `${name} missing render`)
  const rendered = def.output.render({}, { ok: true })
  assert.ok(Array.isArray(rendered) && rendered[0]?.type === 'text', `${name} render not content array`)
}

const status = serialize(await tools.get('sandbox_gate_status').execute({ sandboxRoot }), 'status')
assert.ok(status.parity, 'status missing parity')
assert.equal(status.parity.ok, true, 'status parity not ok')

const sync = serialize(await tools.get('sandbox_gate_sync').execute({ sandboxRoot, dryRun: true }), 'sync')
assert.equal(sync.dryRun, true, 'sync dryRun flag missing')
assert.equal(sync.parity.ok, true, 'sync plan parity not ok')

const guard = serialize(await tools.get('sandbox_gate_guard_test').execute({ sandboxRoot }), 'guard')
assert.equal(guard.ok, true, 'guard selftest failed')

console.log(JSON.stringify({ ok: true, tools: tools.size, guards: guards.length, liveCount: status.parity.liveCount, hostCount: status.parity.hostCount }, null, 2))
