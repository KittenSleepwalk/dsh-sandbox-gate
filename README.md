<div align="center">

# dsh-sandbox-gate

**Mandatory sandbox verification before any plugin touches your host**

A safety plugin for DeepSeek Harness Desktop: **install any candidate plugin into a throwaway sandbox copy first — boot it, cold-restart it twice, check the session and the other plugins — and only let it land on the host once everything passes.**

<a href="https://github.com/KittenSleepwalk/dsh-sandbox-gate/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/KittenSleepwalk/dsh-sandbox-gate?style=flat-square"></a>
<a href="https://github.com/KittenSleepwalk/dsh-sandbox-gate/issues"><img alt="GitHub issues" src="https://img.shields.io/github/issues/KittenSleepwalk/dsh-sandbox-gate?style=flat-square"></a>
<a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-amber.svg?style=flat-square"></a>
<a href="https://github.com/KittenSleepwalk/dsh-sandbox-gate"><img alt="DSH >= 0.2.2-rc.1" src="https://img.shields.io/badge/DSH-%3E%3D0.2.2--rc.1-4d6bfe?style=flat-square"></a>
<img alt="Node >= 20" src="https://img.shields.io/badge/Node-%3E%3D20-339933?style=flat-square">

**English** · [简体中文](./README.zh-CN.md)

</div>

> [!WARNING]
> **Only verified on one machine — not guaranteed to be fully safe.**
>
> - It runs fine on the author's machine, and the plugin itself also passed the sandbox verification flow.
> - But it has **only been tried on that single machine** — never on a second machine, and never on other DSH versions.
> - This plugin creates and deletes throwaway sandbox copies on your machine, starts extra DSH processes, and registers an
>   **install guard** (it intercepts `pnpm add` / `dsh plugin add` / `plugin_manager install_bundle`).
>   Back up `~/.dsh` and your own plugin directories such as `D:\AIProgram` **before** installing.
>
> **It is the prerequisite for the other plugins in this series**: install this package first, and let every plugin after it go through its sandbox verification before it reaches the host. It does not take over automatically — after installing, you have to call `sandbox_gate_install_test` yourself.
>
> ```bash
> pnpm add github:KittenSleepwalk/dsh-sandbox-gate
> ```

---

## 🧭 What problem it solves

When you let an agent design or install a plugin for you, the most likely failure is not "it won't install", but:

- DSH won't come up after the install;
- it comes up, but a session is interrupted or corrupted;
- the new plugin takes other plugins down with it;
- the plugin wants the GPU, and you happen to be using the GPU too;
- you notice something is wrong and force-kill the process, and the agent quietly starts it again.

What this plugin does: **first copy the whole DSH sandbox, then install, cold-restart and run tests inside the copy; if the copy dies, just throw it away — not a single byte of the host profile is changed.**

The host (the DSH Desktop you are using) stays read-only the whole time; all the risk stays in the sandbox. If the sandbox dies, throw the copy away and start over.

---

## 🚀 Install

- **Package:** `@kittensleepwalk/dsh-sandbox-gate`
- **Version:** `1.1.4`
- **Display name:** 插件设计及安装的必须沙盒校验 (mandatory sandbox verification for plugin design and installation)
- **Sandbox directory:** `<sandbox-root>`
- **Bins:** `sandbox-gate`, `dshsandbox`

```bash
# 1) straight from GitHub (the repository root *is* the package root)
pnpm add github:KittenSleepwalk/dsh-sandbox-gate

# 2) or from a local tarball
pnpm pack    # produces kittensleepwalk-dsh-sandbox-gate-1.1.4.tgz
pnpm add ./kittensleepwalk-dsh-sandbox-gate-1.1.4.tgz
```

This package ships its own `cordis.patch.yml`: after installing, just add the package name
`@kittensleepwalk/dsh-sandbox-gate` to `dsh.profile.bundles` in your DSH profile — no hand-written
entry needed. Restart DSH to take effect.

The sandbox root is no longer a hard-coded drive letter: it takes the `DSH_GATE_SANDBOX_ROOT`
environment variable, otherwise `~/DSH-SandBox`. Pass a `sandboxRoot` argument to the tools, or set
that environment variable, to point at your own sandbox directory.

Requirements: Node.js ≥ 20, DSH ≥ 0.2.2-rc.1. `<sandbox-root>` and `%USERPROFILE%` below are placeholders.

> The execution contract for agents lives in `AGENT.md`; the implementation notes for plugin developers live in `docs/` (see `docs/DEVELOPER.md`). This file is for users only.

### Installing through the DSH Desktop plugin manager

Install through the plugin manager inside DSH Desktop (once). **First copy the plugin directory to
the host's own location, then install from there** — do not install the directory inside the sandbox
workspace directly:

```text
1. Copy <sandbox-root>\dsh-sandbox-gate
   to   %USERPROFILE%\.dsh\local-plugins\dsh-sandbox-gate
2. Plugin manager install target:
   %USERPROFILE%\.dsh\local-plugins\dsh-sandbox-gate
```

That way the host loads its own copy and no longer depends on the sandbox directory; cleaning up or
rebuilding the sandbox later will not delete the host plugin along with it.

You can also just tell the agent "copy the plugin to local-plugins on this machine and install it into
desktop from there". After installing, **restart DSH Desktop** and `sandbox_gate_*` appears in the
toolbar.

Do not install with the `dsh plugin --profile desktop add ...` command: the desktop `desktop` profile
is managed exclusively by Electron and the CLI refuses — that is not a plugin fault.

### The sandbox's own live environment

The sandbox is not only a copy generated on the fly for tests; its day-to-day profile has also been
synced into a full environment close to the host:

- profile: `<sandbox-root>\data\dsh-home\profiles\web`
- core: `0.2.2-rc.1` (same as the host; `runtimes\windows-x64\dsh` points at `.sandbox-gate\core\0.2.2-rc.1`)
- plugins: every installable host plugin (33, including local link plugins and the image-generation plugin), **without the sandbox plugin itself and without the injected canary**; it may have more, never fewer
- start: run `windows.bat` directly, or `node scripts\portable.mjs -- --profile web --port 19071 --no-open`

The plugin list is maintained by `sandbox_gate_sync`: whatever the host has and the sandbox lacks is
filled in automatically with `link:`; the sandbox may have more, never fewer. It is normal that the
sandbox has no `sandbox_gate_*` tools — the sandbox plugin is only installed into the pseudo-host or
the host, never into the sandbox.

---

## 🛠 How to use

You don't need to remember tool names; just ask normally:

- "help me design an XXX plugin, verify it in the sandbox first"
- "install this plugin into the sandbox and test it, install it on the host only if it passes"
- "the plugin design from last time was half done, continue the task"

The agent then executes in a fixed order: audit → sandbox install → two cold restarts → check
session / other plugins / whether the candidate is mounted / stability → once it passes, install into
the sandbox's own live plugin list and verify the boot again (T16) → run the functional check if a
functional command was given (T17) → hand you the receipt → only install on the host after you
confirm.

**Without a passing receipt, an agent that tries to install straight onto the host is blocked** — this
does not rely on its self-discipline.

---

## 🎛 When you are asked to pick one of four

If you force-kill the test process, the agent stops, tells you what it was testing at that moment, and
lets you choose:

| Option | Meaning |
|---|---|
| Continue the tool test | You know the tool is legitimate, so keep going; the agent recovers and retests automatically |
| Disallow the current tool | The tool itself is legitimate, but you don't want it to run; the approach changes, and that tool is not restarted |
| Suspend the tool test | Leave it stopped until the GPU is free or you manually say continue; the agent may poll, but it will not start on its own |
| Stop the plugin design entirely | Stop this design and keep the breakpoint; the host is unaffected. Say "continue the task" later to resume |

Whichever you pick, the agent **will not automatically restart** the process you just killed.

---

## 🧪 Test items

The bar is that every required item below must not fail:

| ID | Check |
|---|---|
| T01 | The sandbox boots, HTTP works, the canary heartbeat is present |
| T02 | Two consecutive cold restarts both come up |
| T03 | Session files are intact, the event count does not drop, there is no new corruption |
| T04 | None of the 211 baseline plugins gains a new failure |
| T05 | The candidate plugin is really mounted and active |
| T06 | Through the stability window the heartbeat never stops and the process does not exit |
| T08 | Host profile hashes and the GUI process are unchanged |
| T09 | After rollback the baseline can still boot |
| T15 | Startup latency stays under 40 seconds (catches a half-finished plugin that hangs) |
| T16 | After being installed into the sandbox's own live plugin list, a cold start still comes up and the candidate is active (automatic rollback on failure) |
| T17 | When a functional command was provided, the functional self-check passes |

Also participating, by scenario: T07 session smoke test (needs a real model, skipped by default), T10
conflict, T11 GPU gating, T12 external force-kill, T13 resume, T14 raw backup verification.

---

## 📁 Where reports and backups live

- Per-test report: `<sandbox-root>\.sandbox-gate\evidence\<runId>\report.md`
- Host install record: `...\.sandbox-gate\state\host-installs.json`
- Passing receipts: `...\.sandbox-gate\state\receipts.json`
- Original portable files backup (insurance against GitHub going away or the repo being deleted): `backup\portable-1.0.4\` inside the plugin directory

---

## ❓ FAQ

**Q: Will it slow down or affect the DSH I'm using?**

It does not modify the host profile; tests use their own ports (starting at 19001), permanently
avoiding 8889 and 18787. Tests do consume CPU and memory, and GPU plugins also occupy the GPU.

**Q: What if I don't want it to use the GPU?**

It samples before testing a GPU plugin and refuses to start while the GPU is busy by default. You can
also pick "Suspend the tool test" or "Disallow the current tool" among the four options.

**Q: Do I need to repair the sandbox if it dies?**

No. The copy is throwaway and a failure is discarded automatically; the baseline is read-only, and the
next run copies from the baseline again.

**Q: Can every install be forced through the sandbox?**

Installations initiated by the agent are intercepted by the guard; but **one-click installs from the
plugin marketplace, and commands you type yourself in an external terminal, are not covered by this
guard** — that is a known boundary.

**Q: Is a restart required after installing?**

Yes. The tools and the guard load when DSH starts; without a restart they do not take effect.

---

## 🚧 Boundaries

- It only covers the DSH tool layer, not an operating-system-level sandbox; sandbox processes still run with your user privileges.
- `T03` only does file-level session integrity checking, not semantic conversation verification.
- `dsh-tauri*` / `dsh-taiwind` contain host absolute paths and are excluded from the sandbox by default; they only count as "must not be fewer than the host" exclusions.
- GPU gating is only decided before a test starts; the GPU is still occupied during the test.

---

## 📄 License

[MIT](./LICENSE) © 2026 KittenSleepwalk
