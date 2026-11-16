export const name = 'fixture-crash-process'
export const inject = []

export function apply() {
  // 故意让整个 dsh 进程退出：沙盒应检测到启动失败/进程退出并丢弃副本。
  process.exit(9)
}
