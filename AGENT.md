# AGENT.md · @kittensleepwalk/dsh-sandbox-gate 操作契约

> 本文件是**给智能体看**的执行契约。给用户看的说明在 `README.md`，给插件开发者看的在 `docs/`。
> 不要把本文件内容转述给用户当作使用说明。

## 0. 一句话

任何候选插件在主机 profile 落地前，必须先在本插件的**一次性沙盒副本**里完成 `sandbox_gate_audit` +
`sandbox_gate_install_test`；只有 `verdict=pass` 才允许调用 `sandbox_gate_install` 写入主机。
**没有 pass 凭证的主机安装调用会被工具守卫直接拒绝**，不是靠自觉。

- 沙盒根：`<沙盒根>`
- 基线 profile：`web`；基线 active 条目：211
- 测试端口：从 `19001` 起；永久避开 `8889`、`18787`

## 1. 硬规则（不得绕过）

1. **先审后测**：设计/修改插件后先 `sandbox_gate_audit`；安装前必须
   `sandbox_gate_install_test`。没有 pass 报告不得安装到主机。
2. **主机安装分两步**：`sandbox_gate_install`（`confirm=<包名>`）负责校验凭证并**准备交接**，
   `plugin_manager install_bundle` 负责**真正落盘**。原因：DESKTOP 的 `desktop` profile 在
   DSH 0.2.2+ 由 Electron 应用独占，dsh CLI 一律拒绝写入
   （`error: profile "desktop" is managed exclusively by the Electron application`）。
   不要绕过 CLI 直接改 profile 文件：App 内存态与磁盘态会不一致。
   守卫按凭证放行——同包同版本有 pass 凭证的 `plugin_manager.install_bundle` 允许并放行，
   没有凭证的拒绝；`pwsh` 里的 `dsh plugin add`、主机 profile 里的 `pnpm add` 一律拒绝。
3. **只写沙盒**：常规运行只写 `<sandboxRoot>\.sandbox-gate\**`；唯一例外是
   `sandbox_gate_install` 对主机 profile 的写入（有凭证 + confirm）。禁止写主机
   `DSH_HOME` 的其他目录，禁止占用主机 GUI 端口。
4. **一次一个 run**：`state/gate.lock` 存在时不得并发；失败先读报告与回退，不要盲目重跑。
5. **不自动重启**：用户杀掉工具进程后立即停手，读 `interrupt.json`，把四选一交给用户；
   用户没选之前不得 `resume`。主机 DSH 的重启也永远由用户执行。
6. **候选不进门**：被测插件的源码工作副本放 `<sandboxRoot>\candidates\`；不得放进本插件目录。
7. **基线只读**：候选只装进 `runs/<id>/root`；不得改 `baseline/`，不得把候选写进基线。

## 2. 调用顺序

```
sandbox_gate_status
  ├─ 无清单/主机已变 → sandbox_gate_calibrate
  ├─ parity.ok=false → sandbox_gate_sync（补齐主机插件；沙盒插件自身不装）
  ├─ 无基线 → sandbox_gate_install_test（会自动 ensureBaseline）
  └─ 有基线 → sandbox_gate_pipeline（= 审计 + 系统测试 + 装进 live 沙盒 + 启动验证 + 功能检查）
                → sandbox_gate_logs（看报告）
                → sandbox_gate_receipts（确认 pass 凭证）
                → sandbox_gate_install（confirm=<包名>，校验凭证并准备交接，返回 installMode=handoff）
                → plugin_manager install_bundle（target = handoff.target，真正落盘）
                → 用户重启主机 DSH（本插件不重启主机）
```

- 只做系统级验收、不改 live 沙盒：`sandbox_gate_install_test`（`installLive=false` 为旧行为）。
- `sandbox_gate_pipeline` 里 `T16` 失败会自动回退 live 沙盒安装；`T17` 失败同样回退。
- 模拟主机设计插件时：在模拟主机里调本插件 → 本插件指向真实沙盒根 → 测试通过后装回模拟主机；
  模拟主机目录本身不得进入本插件包或沙盒 live profile。
- 只是复测重启：`sandbox_gate_restart_test`。
- 失败或放弃：`sandbox_gate_rollback`（丢弃副本 + 基线自检）；**失败不得安装主机**。
- 用户强杀/中断：展示四选一 → `sandbox_gate_interrupt` → 需要时 `sandbox_gate_resume`。
- 用户说“继续任务”：先 `sandbox_gate_status` 读 checkpoint，再 `sandbox_gate_resume`。

## 3. 工具契约

所有工具默认 `sandboxRoot=<沙盒根>`；可传绝对路径覆盖。

| 工具 | 参数 | 返回要点 |
|---|---|---|
| `sandbox_gate_status` | 无 | 主机核心版本、清单缓存、基线指纹、备份、上次结论、checkpoint、中断、GPU、live 沙盒注册状态（`live.coreVersion/gateRegistered/canary`） |
| `sandbox_gate_calibrate` | 无 | 重扫主机 asar 版本与 profile 依赖，写 `state/host-inventory.json` |
| `sandbox_gate_sync` | `dryRun?` | 比对主机清单与沙盒 live profile：缺的用 `link:` 补全，移除沙盒插件自身/canary；`ok=true` 才算对齐。沙盒可多不可少 |
| `sandbox_gate_audit` | `path` 或 `spec` | `verdict=ok/warn/reject`、`findings`（A01–A13）、`gpuLikely` |
| `sandbox_gate_install_test` | `path` 或 `spec`；可选 `restartCycles`(默认2) `stability`(30) `requireGpu` `gpuWait` `installLive` `functionalCommand` | `verdict`、`tests`、`failedItems`、`rollback`、报告路径；pass 时写凭证 |
| `sandbox_gate_pipeline` | `path` 或 `spec`；`functionalCommand?`、`restartCycles`、`stability`、`gpuWait`、`force` | 固定流程：审计 → T01–T15 → 装进 live 沙盒(T16) → 启动验证 → 功能检查(T17)；失败自动回退 live 安装 |
| `sandbox_gate_restart_test` | `runId`、`cycles` | 对现有副本重复冷启动并判定 |
| `sandbox_gate_rollback` | `runId` | 丢弃副本、基线自检 |
| `sandbox_gate_receipts` | 无 | 已通过的包名/版本/内容哈希/runId，以及主机安装历史 |
| `sandbox_gate_install` | `path` 或 `spec` + `confirm=<包名>` | 校验凭证与内容哈希后：主机 profile 由 Electron 独占（检出 `.harness.pid` / `.plugin-manager`）→ **直接**返回 `installMode=handoff` + `handoff.target`，**不调用 dsh CLI**；否则才调 CLI 写入 |
| `sandbox_gate_hardware` | `waitSec` | GPU 采样、占卡进程、是否空闲 |
| `sandbox_gate_interrupt` | `runId`、`option` | `continue` / `disallow_tool` / `suspend` / `stop` |
| `sandbox_gate_resume` | `runId`、`cycles` | 从 checkpoint 续跑并出报告 |
| `sandbox_gate_guard_test` | 无 | 守卫判定表自测，验证“直接 add 被拒、其他目录放行” |
| `sandbox_gate_logs` | `runId`、`lines` | 报告 JSON、boot 日志尾部、canary 快照 |

CLI 与工具共用同一套逻辑（无需模型）：

```powershell
$node = "<沙盒根>\runtimes\windows-x64\node\node.exe"
cd "<沙盒根>\dsh-sandbox-gate"
& $node bin\gate.mjs status
& $node bin\gate.mjs audit --path <候选目录>
& $node bin\gate.mjs install-test --path <候选目录> --stability 30
& $node bin\gate.mjs guard-check --command "dsh plugin --profile desktop add foo"
& $node bin\gate.mjs receipts
& $node bin\gate.mjs logs --lines 120
```

### 3.1 `dshsandbox`：装沙盒的独立命令（与 `dsh` 分开）

`dsh` 是主机命令；往沙盒装一律走 `bin/dshsandbox.mjs`：

- **两份副本**：插件内 `bin/dshsandbox.mjs`、沙盒内 `<sandboxRoot>/bin/dshsandbox.mjs`，内容一致；
- **不注册系统 PATH**，调用时给绝对路径；
- **绝对路径来自相对映射**：脚本位于 `<sandboxRoot>/bin/` 时根即其上一级；插件内那份用 `--root` /
  `DSH_GATE_SANDBOX_ROOT` / 默认根兜底；
- **强隔离**：`DSH_HOME` 强制指向 `<sandboxRoot>/data/dsh-home`，目标 profile 不在沙盒根内直接拒绝，
  解析出主机 home 也直接拒绝。

**两种安装模式必须分开用，不要混**：

| 模式 | 用途 | 命令 | 装完自检 |
|---|---|---|---|
| `link` | 把**本机**已装插件映射进沙盒（parity 对齐） | `link <本机插件目录>` | 必须是链接，且指向该目录；目标在沙盒根内直接拒绝 |
| `entity` | 把插件**实体**装进沙盒（隔离测试单个插件） | `entity <spec\|tgz 绝对路径>` | 内容必须在 `<profileDir>` 内；指向 candidates/ 或主机目录即判失败 |

> 注意：`entity` 用**目录**当参数时 pnpm 会装成 `link:`，自检会拒绝——这正是 T16 早期误判的根因。
> 要隔离测试本地候选，先 `npm pack` 成 tgz 再 `entity <tgz>`。

```powershell
$node = "<沙盒根>\runtimes\windows-x64\node\node.exe"
$cli  = "<沙盒根>\bin\dshsandbox.mjs"
& $node $cli where                                   # 打印解析出的 root/home/profile/工具路径/hostHome
& $node $cli link   %USERPROFILE%\.dsh\profiles\desktop\.dsh-local-plugins\dsh-folder --profile web --bundle
& $node $cli entity dsh-context@0.85.1 --profile web --bundle
& $node $cli entity D:\...\{tarball}.tgz --profile web --bundle
& $node $cli remove dsh-context --profile web
& $node $cli list --profile web                      # 列出 link 数量与目标
& $node $cli dsh --profile web plugin list           # 用沙盒的 dsh 二进制，DSH_HOME 指向沙盒
```

## 4. 主机安装守卫（不是建议，是拦截）

插件在 `tools.guard` 注册单调拒绝，拦截三类调用：

1. `pwsh` / `bash` / `terminal` 里的 `dsh plugin ... add`（未指定其他 profile 时按 desktop）；
2. workdir/`--dir` 落在 `%USERPROFILE%\.dsh\profiles\desktop` 的 `pnpm|npm|yarn add|install`；
3. `plugin_manager` 且 `action=install_bundle`。

判定：解析目标包名/版本 → 在 `state/receipts.json` 找同包同版本的 `verdict=pass` 凭证 →
有则放行，无则拒绝并提示先 `sandbox_gate_install_test`。registry/远程源**必须带版本或提交**；
不带版本的 `dsh plugin add foo` 直接拒绝，避免同名旧凭证放行新版本。
`plugin_manager.install_bundle` 走同一条凭证判定：这正是 Electron 独占 profile 时 handoff 落盘
不会被挡的原因；没有凭证的 plugin_manager 安装同样拒绝。
`@kittensleepwalk/dsh-sandbox-gate` 自身安装放行，否则无法升级守卫。

`path` 候选在 `sandbox_gate_install` 里还会校验 `contentHash` 与测试时一致，防止“测完又改”。

边界：只覆盖 DSH 工具层。用户自己在外部终端安装、或直接改 profile 文件，不在此守卫范围内。

## 5. 判定与失败处理

`verdict=pass` 仅当必需项全部非 fail：

`T01` 启动、`T02` 两次冷重启、`T03` session 完整、`T04` 其他插件不崩、`T05` 候选已挂载、
`T06` 稳定性、`T08` 主机未变、`T09` 回退可用、`T15` 启动时延 ≤40s；
`installLive=true` 时额外要求 `T16`（装进 live 沙盒并启动后仍 active，失败自动回退）。

其余项按场景参与：`T07` 会话冒烟（默认 skip）、`T10` 冲突、`T11` GPU、`T12` 外部强杀、
`T13` 续跑、`T14` 备份校验、`T17` 功能检查（提供 `functionalCommand` 时参与）。

- `verdict=fail`：读取 `failedItems` 与 `evidence/<runId>/report.md`；回退已自动执行（`T09` 证明），
  不要在原副本上“修一修再跑”，重新走 `install_test`；**失败不得安装主机**。
- `status=interrupted`：`interrupt.json` 里有正在测试的候选、测试项、被杀的进程命令；把
  `interruptOptions` 原样交给用户选择，不要自行 continue。
- `verdict=reject`：静态审计已拒绝（主机路径、端口、id 冲突等），不要尝试安装。

## 6. 状态与证据位置

```
<sandboxRoot>/.sandbox-gate/
├─ state/{host-inventory.json,gate.json,checkpoint.json,interrupt.json,gate.lock,
│         receipts.json,host-installs.json}
├─ core/<版本>/
├─ baseline/{root,manifest.json}
├─ runs/<id>/{root,run.json,...}
├─ evidence/<id>/{report.json,report.md,boot-*.log}
└─ backup/portable-<版本>/
```

## 7. 已知边界

- `T07` 需要真实模型凭据，默认跳过；`T03` 只覆盖 session 文件级完整性。
- `dsh-tauri*` / `dsh-taiwind` 含主机绝对路径，默认不进沙盒，只作为 parity 排除项。
- 带原生 postinstall 的依赖用 `onlyBuiltDependencies` 白名单，其他构建脚本默认忽略。
- GPU 门控只在启动前判断；测试期间仍会占用本机 GPU/CPU。
- 守卫只在本插件已安装且已加载的主机会话里生效；装完需要重启主机 DSH。
