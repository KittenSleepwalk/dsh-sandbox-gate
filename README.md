# 插件设计及安装的必须沙盒校验

## 安全与状态说明（先读）

> **只在一台机器上验证过，不保证完全安全。**
>
> - 在作者本机运行一切正常；本体也通过了沙盒验证流程。
> - 但**只试验了这一台机器**，没有在第二台机器、也没有在其它 DSH 版本上验证过。
> - 本插件会在你机器上创建/删除一次性沙盒副本、启动额外的 DSH 进程，并注册一个
>   **安装守卫**（会拦截 `pnpm add` / `dsh plugin add` / `plugin_manager install_bundle`）。
>   安装前请先备份 `~/.dsh` 与 `D:\AIProgram` 之类你自己放插件的目录。
>
> **它是本系列其它插件的前置**：建议第一个安装本包，之后所有插件先过它的沙盒验证，
> 过了再进主机。它不会自动接管，需要你在装上后主动调用 `sandbox_gate_install_test`。
>
> ```bash
> pnpm add github:KittenSleepwalk/dsh-sandbox-gate
> ```

## 安装

```bash
# 方式一：直接从 GitHub 装（仓库根就是包根）
pnpm add github:KittenSleepwalk/dsh-sandbox-gate

# 方式二：本地 tarball
pnpm pack    # 产出 kittensleepwalk-dsh-sandbox-gate-1.1.4.tgz
pnpm add ./kittensleepwalk-dsh-sandbox-gate-1.1.4.tgz
```

本包自带 `cordis.patch.yml`，装好后把包名 `@kittensleepwalk/dsh-sandbox-gate`
加进 DSH profile 的 `dsh.profile.bundles` 即可，不需要手写 entry；重启 DSH 生效。

沙盒根不再写死盘符：默认取环境变量 `DSH_GATE_SANDBOX_ROOT`，否则 `~/DSH-SandBox`。
给工具传 `sandboxRoot` 参数、或设该环境变量，即可指到自己的沙盒目录。

要求：Node.js ≥ 20，DSH ≥ 0.2.2-rc.1。下文的 `<沙盒根>`、`%USERPROFILE%` 是占位符。

一个给 DeepSeek Harness Desktop 用的安全插件：**任何新插件在装进你的主机之前，先在一份一次性的沙盒副本里装一遍、重启两遍、检查 session 和其他插件，全过了才允许落地。**

主机（你正在用的 DSH Desktop）始终是只读的；所有风险都留在沙盒里。沙盒崩了，丢掉副本重来即可。

- 插件包：`@kittensleepwalk/dsh-sandbox-gate`
- 显示名：插件设计及安装的必须沙盒校验
- 沙盒目录：`<沙盒根>`

> 给智能体看的执行契约在 `AGENT.md`，给插件开发者看的实现在 `docs/`。本文件只面向使用者。

---

## 1. 它解决什么问题

让 agent 帮你设计/安装插件时，最容易出的事不是“装不上”，而是：

- 装完 DSH 起不来；
- 起得来，但 session 被打断或写坏；
- 新插件把别的插件带崩；
- 插件要显卡，正好你也在用显卡；
- 你发现不对，强制结束了进程，agent 又偷偷把它拉起来。

这个插件的做法：**先复制一份完整的 DSH 沙盒，在副本里安装、冷重启、跑测试；副本崩了就直接丢掉，主机 profile 一个字节都不改。**

## 2. 安装

在 DSH Desktop 里通过插件管理器安装（只需一次）。**先把插件目录复制到主机自己的位置，再从那里安装**，不要直接装沙盒工作区里的目录：

```text
1. 复制 <沙盒根>\dsh-sandbox-gate
   到   %USERPROFILE%\.dsh\local-plugins\dsh-sandbox-gate
2. 插件管理器安装目标填：
   %USERPROFILE%\.dsh\local-plugins\dsh-sandbox-gate
```

这样主机加载的是主机自己的副本，不依赖沙盒目录；以后清理或重建沙盒，不会把主机插件一起删掉。

也可以直接对 agent 说「把插件复制到本机 local-plugins 再从那里装到 desktop」。装完**重启 DSH Desktop**，工具栏里会出现 `sandbox_gate_*`。

不要用 `dsh plugin --profile desktop add ...` 命令安装：桌面端的 `desktop` profile 由 Electron 独占管理，CLI 会拒绝，这不是插件故障。

### 沙盒自己的 live 环境

沙盒不只是测试时临时生成副本，它的日常 profile 也已经同步成和主机相近的完整环境：

- profile：`<沙盒根>\data\dsh-home\profiles\web`
- 核心：`0.2.2-rc.1`（与主机一致；`runtimes\windows-x64\dsh` 指向 `.sandbox-gate\core\0.2.2-rc.1`）
- 插件：主机所有可安装插件（33 个，含本地 link 插件和生图插件），**不装沙盒插件自身、不注入 canary**；可以多，不能少
- 启动：直接跑 `windows.bat`，或 `node scripts\portable.mjs -- --profile web --port 19071 --no-open`

插件清单由 `sandbox_gate_sync` 维护：主机有、沙盒没有的会自动用 `link:` 补上；沙盒可以多，不能少。沙盒里没有 `sandbox_gate_*` 工具是正常的——沙盒插件只装进拟主机或主机，不装进沙盒。

## 3. 怎么用

你不需要记工具名，正常提要求即可：

- 「帮我设计一个 XXX 插件，先在沙盒里验证」
- 「把这个插件装进沙盒测一下，通过了再装主机」
- 「上次那个插件设计到一半，继续任务」

agent 会按固定顺序执行：审计 → 沙盒安装 → 两次冷重启 → 检查 session / 其他插件 / 候选是否挂载 / 稳定性 → 通过后安装进沙盒自己的 live 插件列表并再启动验证（T16）→ 有功能命令时跑功能检查（T17）→ 给你凭证 → 经你确认才装主机。

**没有通过凭证时，agent 直接往主机装会被拦截**，这不是靠它自觉。

## 4. 你被问到四选一的时候

如果你强制结束了测试进程，agent 会停下来，告诉你当时在测什么，然后让你选：

| 选项 | 含义 |
|---|---|
| 继续工具测试 | 你知道这个工具是合法的，继续跑；由 agent 自动恢复并重测 |
| 不允许当前工具使用 | 工具本身合法，但你不想让它跑；换方案，不重启该工具 |
| 挂起工具测试 | 先停着，等显卡空闲或你手动说继续；agent 可以轮询，但不会自动开跑 |
| 彻底停止插件设计 | 停止本次设计，保留断点；主机不受影响。之后说「继续任务」可接续 |

无论选哪个，agent 都**不会自动重启**你刚杀掉的进程。

## 5. 测试项目

通过标准是下面这些必需项全部不失败：

| 编号 | 检查 |
|---|---|
| T01 | 沙盒能启动，HTTP 正常，canary 心跳在 |
| T02 | 连续两次冷重启都能起来 |
| T03 | session 文件完整、事件数不减少、没有新的损坏 |
| T04 | 原有 211 个基线插件没有新增失败 |
| T05 | 候选插件确实挂载并 active |
| T06 | 稳定运行期内心跳不断、进程不退出 |
| T08 | 主机 profile 哈希与 GUI 进程未被改动 |
| T09 | 回退后基线仍然能启动 |
| T15 | 启动时延不超过 40 秒（防半成品卡死） |
| T16 | 装进沙盒自己的 live 插件列表后，冷启动仍能起来且候选 active（失败自动回退） |
| T17 | 提供了功能命令时，功能自检通过 |

按场景参与的还有：T07 会话冒烟（需要真实模型，默认跳过）、T10 冲突、T11 显卡门控、T12 外部强杀、T13 续跑、T14 原始备份校验。

## 6. 报告和备份在哪

- 每次测试的报告：`<沙盒根>\.sandbox-gate\evidence\<runId>\report.md`
- 主机安装记录：`...\.sandbox-gate\state\host-installs.json`
- 通过凭证：`...\.sandbox-gate\state\receipts.json`
- 便携版原始文件备份（防 GitHub 失联/删库）：插件目录下 `backup\portable-1.0.4\`

## 7. 常见问题

**Q：会不会拖慢或影响我正在用的 DSH？**
不会改主机 profile；测试用独立端口（19001 起），永久避开 8889 和 18787。测试会占 CPU/内存，显卡插件还会占显卡。

**Q：我不想让它用显卡怎么办？**
测试显卡插件前会采样；忙的时候默认拒绝启动。你也可以在四选一里选「挂起工具测试」或「不允许当前工具使用」。

**Q：沙盒崩了要修吗？**
不用。副本是一次性的，失败自动丢弃；基线只读，下次从基线重新复制。

**Q：能保证所有安装都走沙盒吗？**
agent 发起的安装会被守卫拦截；但**插件市场的一键安装、以及你自己在外部终端手敲的命令不受此守卫约束**，这是已知边界。

**Q：装完必须重启吗？**
是。工具和守卫在 DSH 启动时加载；不重启不会生效。

## 8. 边界

- 只覆盖 DSH 工具层，不是操作系统级沙盒；沙盒进程仍以你的用户权限运行。
- `T03` 只做 session 文件级完整性检查，不做语义级对话验证。
- `dsh-tauri*` / `dsh-taiwind` 含主机绝对路径，默认不纳入沙盒，只作为“必须比主机多”的排除项。
- 显卡门控只在测试启动前判断，测试期间仍会占用显卡。
