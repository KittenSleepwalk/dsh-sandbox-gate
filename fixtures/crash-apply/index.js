export const name = 'fixture-crash-apply'
export const inject = []

export function apply() {
  throw new Error('fixture-crash-apply: 故意的 apply 崩溃（应只让本插件 failed）')
}
