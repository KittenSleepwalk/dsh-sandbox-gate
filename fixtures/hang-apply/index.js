export const name = 'fixture-hang-apply'
export const inject = []

export function apply() {
  // 故意同步阻塞 45s：超过 T15 启动时延阈值（30s），但仍在 90s 启动超时内。
  const end = Date.now() + 45_000
  while (Date.now() < end) {
    /* busy wait */
  }
}
