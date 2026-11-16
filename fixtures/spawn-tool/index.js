import { spawn } from 'node:child_process'

export const name = 'fixture-spawn-tool'
export const inject = []

/**
 * 模拟“插件工具进程”：apply 时拉起一个长期子进程（类似出图插件的 python worker）。
 * 用于验证：用户在任务管理器里强杀子进程后，网关能发现、暂停、不自动重启，并给出四选一。
 */
export function apply() {
  const child = spawn(process.execPath, ['-e', '/*GATE_TOOL_WORKER*/ setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    detached: false,
  })
  child.unref()
}
