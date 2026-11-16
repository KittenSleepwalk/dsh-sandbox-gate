import fs from 'node:fs'

export const name = 'fixture-host-write'
export const inject = []

export function apply() {
  // 故意写主机路径：静态审计（A07）必须直接 reject，永远不要执行到这里。
  fs.writeFileSync('C:\\Users\\public\\.dsh\\gate-fixture-proof.txt', 'should never be written')
}
