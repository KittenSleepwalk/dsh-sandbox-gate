#!/usr/bin/env node
/**
 * dshsandbox —— 只负责“往沙盒里装”，与 `dsh`（主机）命令彻底分开。
 *
 * 设计约定：
 *  1. 不注册到系统 PATH；调用方给绝对路径。
 *  2. 两份副本：插件内 `bin/dshsandbox.mjs`、沙盒内 `<sandboxRoot>/bin/dshsandbox.mjs`。
 *  3. 绝对路径由脚本自身位置相对映射，不写死盘符。
 *  4. 任何操作都把 DSH_HOME 强制指向 <sandboxRoot>/data/dsh-home，绝不碰 ~/.dsh；
 *     目标 profile 目录必须落在沙盒根内，否则直接拒绝。
 *  5. **两种安装模式必须分开**：
 *     - `link`   ：把本机（主机 profile）已安装的插件目录 link 进沙盒，用于 parity 对齐。
 *     - `entity` ：把插件实体装进沙盒（真拷贝，不是 link），用于隔离单个插件的测试。
 *     装完会自检：`link` 必须确实是链接；`entity` 必须确实不是链接，否则判失败。
 *
 * 用法：
 *   node <绝对路径>/dshsandbox.mjs where
 *   node <绝对路径>/dshsandbox.mjs link <本机插件目录> [--profile web] [--bundle]
 *   node <绝对路径>/dshsandbox.mjs entity <spec|tgz 绝对路径> [--profile web] [--bundle] [--with-scripts]
 *   node <绝对路径>/dshsandbox.mjs remove <包名> [--profile web]
 *   node <绝对路径>/dshsandbox.mjs install [--profile web] [--prod]
 *   node <绝对路径>/dshsandbox.mjs list [--profile web]
 *   node <绝对路径>/dshsandbox.mjs dsh <dsh 子命令...>
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SELF = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)))

function fail(message) {
  console.error(`[dshsandbox] ${message}`)
  process.exit(2)
}

function takeFlag(argv, name) {
  const i = argv.indexOf(name)
  if (i === -1) return undefined
  const value = argv[i + 1]
  const usable = value && !value.startsWith('--')
  argv.splice(i, usable ? 2 : 1)
  return usable ? value : true
}

function takeSwitch(argv, name) {
  const i = argv.indexOf(name)
  if (i === -1) return false
  argv.splice(i, 1)
  return true
}

const isFlagString = (value) => typeof value === 'string' && value.length > 0
const norm = (p) => path.resolve(p).replace(/\\/g, '/')

/** 沙盒根相对映射：<root>/bin/本脚本 → 上一级；否则 --root / 环境变量 / 插件默认。 */
function resolveRoot(flagValue) {
  const candidates = []
  if (isFlagString(flagValue)) candidates.push(path.resolve(flagValue))
  if (process.env.DSH_GATE_SANDBOX_ROOT) candidates.push(path.resolve(process.env.DSH_GATE_SANDBOX_ROOT))
  candidates.push(path.dirname(SELF))
  candidates.push(path.join(os.homedir(), 'DSH-SandBox'))
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'scripts', 'portable.mjs'))) return candidate
  }
  fail(
    `无法定位沙盒根。尝试过：\n${candidates.map((c) => `  - ${c}`).join('\n')}\n` +
      '给 --root <沙盒根>，或把本脚本放到 <sandboxRoot>/bin/。',
  )
}

const argv = process.argv.slice(2)
const rootFlag = takeFlag(argv, '--root')
const profileFlag = takeFlag(argv, '--profile')
const wantBundle = takeSwitch(argv, '--bundle')
const withScripts = takeSwitch(argv, '--with-scripts')
const prod = takeSwitch(argv, '--prod')
const pmFlag = takeFlag(argv, '--pm')
const allowMixedPm = takeSwitch(argv, '--allow-mixed-pm')
// 包管理器只是“往沙盒里装”的执行器：npm 与 pnpm 都可以，默认 pnpm（DSH 自身用它）。
const pm = pmFlag === 'npm' ? 'npm' : 'pnpm'
const command = argv.shift() || 'where'

const root = resolveRoot(rootFlag)
const home = path.join(root, 'data', 'dsh-home')
const profile = isFlagString(profileFlag) ? profileFlag : 'web'
const profileDir = path.join(home, 'profiles', profile)
const node = path.join(root, 'runtimes', 'windows-x64', 'node', 'node.exe')
const pnpm = path.join(root, 'runtimes', 'windows-x64', 'dsh', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
const npmCli = path.join(root, 'runtimes', 'windows-x64', 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js')
const dshBin = path.join(root, 'runtimes', 'windows-x64', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const hostHome = path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')

const withinRoot = (p) => path.resolve(p).toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep)

if (!withinRoot(profileDir)) fail(`拒绝执行：目标 profile 不在沙盒根内（${profileDir}）`)
if (path.resolve(home).toLowerCase() === path.resolve(hostHome).toLowerCase()) {
  fail(`拒绝执行：DSH_HOME 解析成了主机 home（${home}）`)
}
if (!fs.existsSync(node)) fail(`沙盒 node 不存在：${node}`)
if (!fs.existsSync(pnpm)) fail(`沙盒 pnpm 不存在：${pnpm}`)
if (!fs.existsSync(path.join(profileDir, 'package.json'))) fail(`目标 profile 不存在：${profileDir}`)
if (pm === 'npm' && fs.existsSync(path.join(profileDir, 'pnpm-lock.yaml'))) {
  console.error(`[dshsandbox] 提示：该 profile 已有 pnpm-lock.yaml，用 npm 会另生成 package-lock.json；落点仍是沙盒，但两套锁文件并存。`)
}

function env() {
  return { ...process.env, DSH_HOME: home, DSH_PORTABLE_NO_AUTO_UPDATE: '1', NO_COLOR: '1' }
}

/**
 * 包管理器只是“往沙盒里装”的执行器，pnpm / npm 等价（默认 pnpm，DSH 自身用它）。
 * 无论选哪个，cwd 永远是沙盒 profile、DSH_HOME 永远指向沙盒 —— 落点不会变。
 */
function translatePmArgs(args) {
  if (pm === 'pnpm') return args
  const verbMap = { add: 'install', remove: 'uninstall', list: 'ls' }
  const out = []
  for (const arg of args) {
    if (arg === '--no-frozen-lockfile' || arg === '--frozen-lockfile') continue
    if (arg === '--prod') {
      out.push('--omit=dev')
      continue
    }
    out.push(verbMap[arg] || arg)
  }
  if (!out.includes('--no-audit')) out.push('--no-audit', '--no-fund')
  return out
}

function runPnpm(args, timeout = 15 * 60 * 1000) {
  return execFileSync(node, [pm === 'npm' ? npmCli : pnpm, ...translatePmArgs(args)], {
    cwd: profileDir,
    env: env(),
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
}

const pkgPath = path.join(profileDir, 'package.json')
// 带 BOM 的 package.json 在 Windows 上很常见，JSON.parse 会直接炸；读的时候先剥掉。
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
const readPkg = () => readJson(pkgPath)
const depsOf = (pkg) => ({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) })

function addBundle(name) {
  const pkg = readPkg()
  pkg.dsh = pkg.dsh || {}
  pkg.dsh.profile = pkg.dsh.profile || {}
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []
  if (bundles.includes(name)) return { bundle: name, added: false }
  pkg.dsh.profile.bundles = [...bundles, name]
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))
  return { bundle: name, added: true }
}

const installedPath = (name) => path.join(profileDir, 'node_modules', ...name.split('/'))

/**
 * 实体安装自检：判据不是“是不是符号链接”（pnpm hoisted 布局下 node_modules/<pkg>
 * 本来就链到 profile 内的 .pnpm 库），而是**内容落在哪里**：
 *   - realPath 在 <profileDir> 内 → 实体（真拷贝/真解包），隔离成立；
 *   - realPath 在 profile 之外（candidates/、主机插件目录…）→ 只是 link，隔离无效。
 */
function assertEntity(name) {
  const target = installedPath(name)
  let real
  try {
    real = fs.realpathSync(target)
  } catch {
    fail(`实体安装自检失败：${name} 没出现在 ${target}`)
  }
  const profileLower = path.resolve(profileDir).toLowerCase() + path.sep
  if (!path.resolve(real).toLowerCase().startsWith(profileLower)) {
    fail(`实体安装自检失败：${name} 的内容在 profile 之外（${real}）——这是 link，不是实体安装，隔离测试无效`)
  }
  const installed = readJson(path.join(real, 'package.json'))
  return { name, version: installed.version, realPath: real, isolatedWithinProfile: true }
}

/** link 模式自检：必须确实是指向目标目录的链接。 */
function assertLink(name, expectedDir) {
  const target = installedPath(name)
  let st
  try {
    st = fs.lstatSync(target)
  } catch {
    fail(`link 安装自检失败：${name} 没出现在 ${target}`)
  }
  const real = fs.realpathSync(target)
  const want = fs.realpathSync(expectedDir)
  if (!st.isSymbolicLink()) {
    fail(`link 安装自检失败：${name} 不是链接（realPath=${real}），parity 映射无效`)
  }
  if (path.resolve(real).toLowerCase() !== path.resolve(want).toLowerCase()) {
    fail(`link 安装自检失败：${name} 指向 ${real}，期望 ${want}`)
  }
  return { realPath: real, linked: true }
}

/** 安装前后对比依赖，识别出这一次变动的包名（tgz / 目录 / 版本号都适用）。 */
function detectChangedName(beforeDeps) {
  const after = depsOf(readPkg())
  const changed = Object.keys(after).filter((name) => after[name] !== beforeDeps[name])
  if (changed.length === 0) fail('安装后没有检测到依赖变化，无法识别包名')
  if (changed.length > 1) fail(`安装后依赖变化不止一个：${changed.join(', ')}，请一次只装一个包`)
  return { name: changed[0], spec: after[changed[0]] }
}

try {
  switch (command) {
    case 'where': {
      console.log(
        JSON.stringify(
          { command: 'where', self: SELF, root, home, profile, profileDir, node, pm, pnpm, npmCli, dshBin, hostHome },
          null,
          2,
        ),
      )
      break
    }

    // 模式一：link —— 把本机已装插件映射进沙盒（parity 对齐用）
    case 'link': {
      const targetDir = argv.shift()
      if (!targetDir) fail('link 需要 <本机插件目录>')
      const dir = path.resolve(targetDir)
      if (!fs.existsSync(path.join(dir, 'package.json'))) fail(`link 目标不是插件目录（缺 package.json）：${dir}`)
      if (withinRoot(dir)) fail(`link 目标在沙盒根内（${dir}）；link 模式只用于“主机 → 沙盒”的映射`)
      const name = readJson(path.join(dir, 'package.json')).name
      const beforeDeps = depsOf(readPkg())
      const output = runPnpm(['add', `link:${norm(dir)}`, '--ignore-scripts'])
      const check = assertLink(name, dir)
      const bundle = wantBundle ? addBundle(name) : null
      console.log(
        JSON.stringify(
          { command: 'link', mode: 'link', name, from: dir, depSpec: depsOf(readPkg())[name], profile, check, bundle, output: String(output).slice(-600) },
          null,
          2,
        ),
      )
      break
    }

    // 模式二：entity —— 把插件实体装进沙盒（真拷贝），用于隔离测试
    case 'entity': {
      const spec = argv.shift()
      if (!spec) fail('entity 需要 <spec|tgz 绝对路径>')
      const beforeDeps = depsOf(readPkg())
      const args = ['add', spec]
      if (!withScripts) args.push('--ignore-scripts')
      const output = runPnpm(args)
      const { name, spec: depSpec } = detectChangedName(beforeDeps)
      const check = assertEntity(name)
      const bundle = wantBundle ? addBundle(name) : null
      console.log(
        JSON.stringify(
          { command: 'entity', mode: 'entity', name, requested: spec, depSpec, profile, check, bundle, output: String(output).slice(-600) },
          null,
          2,
        ),
      )
      break
    }

    case 'remove': {
      const name = argv.shift()
      if (!name) fail('remove 需要 <包名>')
      const output = runPnpm(['remove', name])
      console.log(JSON.stringify({ command: 'remove', name, profile, output: String(output).slice(-600) }, null, 2))
      break
    }

    case 'install': {
      const args = ['install', '--no-frozen-lockfile']
      if (prod) args.push('--prod')
      if (!withScripts) args.push('--ignore-scripts')
      const output = runPnpm(args)
      console.log(JSON.stringify({ command: 'install', profile, output: String(output).slice(-600) }, null, 2))
      break
    }

    case 'list': {
      const output = runPnpm(['list', '--depth', '0'])
      const deps = depsOf(readPkg())
      const links = Object.entries(deps)
        .filter(([, v]) => String(v).startsWith('link:'))
        .map(([name, v]) => ({ name, target: v.slice(5) }))
      console.log(JSON.stringify({ command: 'list', profile, linkCount: links.length, links, output: String(output).slice(-1500) }, null, 2))
      break
    }

    case 'dsh': {
      if (!fs.existsSync(dshBin)) fail(`沙盒 dsh 不存在：${dshBin}`)
      const output = execFileSync(node, [dshBin, ...argv], {
        cwd: home,
        env: env(),
        timeout: 15 * 60 * 1000,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      })
      console.log(JSON.stringify({ command: 'dsh', args: argv, output: String(output).slice(-4000) }, null, 2))
      break
    }

    default:
      fail(`未知子命令：${command}（可用 where/link/entity/remove/install/list/dsh）`)
  }
} catch (error) {
  const stderr = String(error?.stderr || '').trim()
  const stdout = String(error?.stdout || '').trim()
  fail(`${error?.message || error}${stdout ? `\nstdout: ${stdout.slice(-1500)}` : ''}${stderr ? `\nstderr: ${stderr.slice(-1500)}` : ''}`)
}
