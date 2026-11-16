# 开发者文档 · @kittensleepwalk/dsh-sandbox-gate

> 本目录只放**给插件开发者**看的内容：架构、模块边界、数据格式、扩展点。
> 给用户看的在根目录 `README.md`；给智能体看的执行契约在根目录 `AGENT.md`。
> 三者不要互相复制。

## 1. 设计约束

1. **主机零写**：运行期只写 `<sandboxRoot>/.sandbox-gate/**`；唯一的例外是
   `sandbox_gate_install` 在拿到 pass 凭证 + `confirm` 后写主机 `desktop` profile。
2. **一次性副本**：候选只装进 `runs/<id>/root`。失败 = 丢弃副本 + 基线自检，不做“原地修复”。
3. **基线只读**：`baseline/root` 只在构建时写入；候选永远不进基线。
4. **无模型观测**：沙盒内注入 canary 插件，把 loader 条目状态写盘；测试用文件判断，不消耗 LLM token。
5. **不自动重启**：外部杀进程只记录、停手，由用户四选一。
6. **不依赖主机 core**：`.sandbox-gate/core/<版本>` 单独安装与主机同版本的 `@deepseek-ai/dsh`；
   不走 `portable.mjs`（它会按自带 manifest 重装 0.1.7）。
7. **主机副本与沙盒解耦**：主机 `desktop` profile 里安装的是
   `%USERPROFILE%\.dsh\local-plugins\dsh-sandbox-gate` 的副本（link 到主机自己的目录），
   不是沙盒工作区里的源码目录。清理/重建沙盒不会影响主机加载本插件；升级时先改工作区、
   测试通过后再同步副本并让主机重载。
8. **live 沙盒 = 已同步环境，不是测试副本**：`data/dsh-home/profiles/web` 由
   `.sandbox-gate/tools/sync-live-profile.mjs` + `sandbox_gate_sync` 维护，包含主机所有可安装插件
   （本地插件用 `link:` 指向主机目录），**不装沙盒插件自身、不注入 canary**。
   `runtimes/windows-x64/dsh` 是指向 `.sandbox-gate/core/<host 版本>` 的 junction。
   测试仍然只操作 `runs/<id>/root`；live 环境只用于人眼查看和日常使用。

## 2. 模块图
```
lib/
├─ index.js        插件入口：注册 15 个工具 + tools.guard；所有返回值做 lossless JSON 归一化
├─ config.js       默认路径/端口/阈值；禁 8889、18787；GPU 阈值 util 40% / mem 65%
├─ paths.js        GatePaths：所有路径必须落在 sandboxRoot 内；拒绝主机 DSH_HOME/profile
├─ host.js         从 asar 读主机 core 版本、profile 依赖/ bundles、主机指纹、端口占用
├─ backup.js       portable 原始文件备份 + SHA256SUMS 校验
├─ baseline.js     安装 core、生成基线 profile、复制 link/file 依赖、pnpm install、原子替换
├─ run.js          创建/销毁一次性 run 副本；迁移 node_modules/.modules.yaml 的 virtualStoreDir
├─ audit.js        A01–A13 静态审计（结构、路径、端口、进程、符号链接、id 冲突、GPU 提示）
├─ launch.js       启动/停止沙盒 dsh；解析 token URL；canary 读取；进程快照
├─ sessions.js     session 文件扫描、zstd 解压、事件数、损坏检测、前后对比
├─ hardware.js     nvidia-smi 采样与空闲判断
├─ state.js        lock / checkpoint / interrupt / receipts / host-installs
├─ pipeline.js     编排：基线、bootOnce、T01–T17、报告、回退、install/restart test
├─ live.js         live 沙盒安装（候选复制进 sandbox/candidates）、临时 canary 启动验证、功能命令
├─ guard.js        tools.guard 安装拦截；解析 shell / plugin_manager 安装意图；8 条自测
├─ parity.js       主机插件清单 ↔ live profile 比对；缺项 link: 补全；移除沙盒自身/canary
└─ host-install.js 凭证校验 + 调 dsh CLI 写 desktop profile + 安装记录

bin/gate.mjs       CLI：与工具共用 lib，用于无模型、确定性自测
canary/            沙盒内的只写盘观测插件（file: 依赖注入）
fixtures/          故障注入插件（crash-apply/crash-process/corrupt-session/half-session/
                   hang-apply/conflict-id/spawn-tool/host-write）
backup/            portable 原始文件备份（随插件分发）
```

## 3. 一次 install_test 的生命周期

```
acquireLock
→ cachedInventory（无则 calibrate）
→ ensureBackup
→ auditCandidate（reject 直接返回；warn 需 force）
→ needsGpu? gpuGate
→ ensureBaseline（构建/校验指纹；首次启动记录 baselineActive 与 baselineNoise）
→ hostSnapshot(before)
→ createRun：复制 data/scripts，junction runtimes/bin/packages，relocateVirtualStores
→ stageCandidate：复制候选 → pnpm add --ignore-scripts → 按需写入 profile bundles
→ bootOnce × (1 + restartCycles)
→ aggregateTests（T02/T05/T06/T03/T04/T15…）
→ [installLive] 候选复制进 <sandbox>/candidates → pnpm add 到 live profile
→ [installLive] verifyLiveBoot（临时 canary patch + --patch 启动，30s 内等候选 active）
→ [installLive] functionalCommand → T17
→ [installLive 失败] rollbackLiveInstall（pnpm remove + 恢复 profile 备份）
→ disposeRun
→ baselineSelfCheck（T09）
→ hostSnapshot(after)（T08）
→ T10 冲突 / T14 备份 / T11 GPU
→ writeReport + writeReceipt(pass)
→ releaseLock
```

失败路径同样 `disposeRun` + `baselineSelfCheck`；异常中断保留 run 与 checkpoint，供 resume。

## 4. 判定语义

- `pass`：`REQUIRED = [T01,T02,T03,T04,T05,T06,T08,T09,T15]` 全部非 fail；
  `installLive=true` 时再加 `T16`（装进 live 后启动仍 active；失败自动回退 live 安装）。
- `T17` 只在提供 `functionalCommand` 时参与；失败同样回退 live 安装并判 fail。
- 单个测试状态为 `pass | fail | warn | skip`；`warn` 不阻断，`skip` 不计入必需项。
- `T06` 有 warmup：canary active 达到基线 90% 后才开始计时；心跳阈值 8s，canary 自身 2s 写盘。
- `T15` 用 `bootMs` 判断，默认 40s；半成品插件 apply 阻塞会在这里暴露。
- `T04` 的噪声白名单：`EBUSY ntuser.dat`、`hmr`；其余 `Error:|FAILED|failed to activate|ENOENT|EACCES` 记为新增错误。
- 外部杀进程：只把生命周期 ≥6s 的子进程消失当作“用户杀了工具”，短暂 pnpm/git 子进程忽略。

## 5. 数据格式

`state/gate.json`（最近一次）：

```json
{ "status": "pass|fail|interrupted", "runId": "...", "verdict": "pass|fail",
  "candidate": {"name":"...","version":"..."}, "finishedAt": "ISO",
  "tests": {"T01":{"status":"pass","detail":"..."}}, "failedItems": [] }
```

`state/receipts.json`：数组，元素
`{verdict,packageName,version,spec,kind,contentHash,runId,coreVersion,recordedAt}`。

`state/interrupt.json`：`{reason,stage,runId,candidate,toolProcess:{pid,command,livedMs},options}`。

`evidence/<runId>/report.json`：完整 `tests`、`failedItems`、`hostBefore/After`、`audit`、`baseline`。

## 6. 守卫的接入点

`registerGuard(ctx, config, log)` 调 `ctx.tools.guard(fn)`。`fn(execution)` 返回 `undefined` 放行，
返回字符串即拒绝（字符串会原样给模型看）。`execution` 含 `name`、`arguments`。
新增拦截面时：

1. 在 `extractInstallIntent` 增加工具名/参数解析；
2. 在 `guardSelfTest` 增加“应拒绝”和“应放行”各一条；
3. 跑 `node bin/gate.mjs guard-selftest`，8/8→N/N；
4. 不改变既有拒绝顺序（self-add 放行必须保留）。

## 7. 扩展测试项

1. 在 `pipeline.js` 的 `bootOnce` 或 `aggregateTests` 产出 `{status, detail}`；
2. 若要阻断，加入 `REQUIRED` 与 `ID_NAMES`；
3. 用 fixtures 造一个能稳定触发失败的插件；
4. 同时更新 `AGENT.md` 的测试表与用户 `README.md` 的测试表；
5. 回归跑一遍 `install-test`（至少 crash-process / corrupt-session / hang-apply 三个）。

## 8. 调试

```powershell
$node = "<沙盒根>\runtimes\windows-x64\node\node.exe"
cd "<沙盒根>\dsh-sandbox-gate"

& $node bin\gate.mjs status
& $node bin\gate.mjs baseline
& $node bin\gate.mjs self-check
& $node bin\gate.mjs logs --lines 150
& $node bin\gate.mjs guard-selftest
```

- 基线启动失败：先看 `baseline/manifest.json` 的 `warnings` 与 `boot-*.log`。
- pnpm 虚拟商店错误：检查 run 副本里的 `node_modules/.modules.yaml` 的 `virtualStoreDir` 是否指向本 run。
- 候选装不上：检查 `runs/<id>/.sandbox-gate/install.log`。
- 主机安装被拒：看 `state/receipts.json` 是否有同包同版本 pass；`path` 候选还要 contentHash 一致。

## 9. 已知取舍

- 不修改 DSH loader/CLI，因此无法拦截插件市场一键安装与外部终端；守卫只覆盖工具层。
- `dsh-tauri*` 需要主机绝对路径与 Electron 环境，默认排除，不纳入 parity。
- 构建脚本默认不执行，只对 `onlyBuiltDependencies` 白名单放行；需要原生构建的插件会审计 warn。
- 沙盒与主机共用同一块磁盘和用户权限，不是 OS 级隔离；它的价值是“可丢弃 + 不改主机”。
- `T07` 需要真实模型，未纳入必需项。
