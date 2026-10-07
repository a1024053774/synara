# 本地构建入口

在 macOS arm64 上，经 `a2a/scripts/bun` 调用这个 fork 的 Bun 命令。checkout 和 `node_modules` 位于内置盘；缓存、Node 工具链和隔离运行数据位于 `/Volumes/WD-Elements/dev-cache/synara/`。入口检查卷为真实挂载点且与 checkout 不同设备；缺盘、内置目录冒充挂载点或管理路径经符号链接逃出外置盘均在启动 Bun 前退出 2。

```sh
./a2a/scripts/bun setup-node
A2A_SYNARA_SLOT=t034 ./a2a/scripts/bun install --frozen-lockfile
A2A_SYNARA_SLOT=t034 ./a2a/scripts/bun run build
A2A_SYNARA_SLOT=t034 SYNARA_PORT_OFFSET=1034 ./a2a/scripts/bun run dev --dry-run
A2A_SYNARA_SLOT=t034 SYNARA_PORT_OFFSET=1034 ./a2a/scripts/bun run dev
A2A_SYNARA_SLOT=t034 ./a2a/scripts/bun run start:desktop
```

`setup-node` 从 [Node 官方 24.13.1 发布目录](https://nodejs.org/dist/v24.13.1/) 下载 macOS arm64 包，按该目录 `SHASUMS256.txt` 校验后解压到 `toolchains/`。它拒绝覆盖已有工具链和下载文件；失败文件保留供检查。后续调用验证 Node v24.13.1，只在子进程的 PATH 前置该工具链，不安装 mise，也不修改全局 Node 或 shell 配置。本机使用 Bun 1.4.2，与 `.mise.toml`、`packageManager` 一致。

| 环境变量 | 缓存根目录下的相对路径 | 官方依据（核实于 2026-10-07） |
| --- | --- | --- |
| `BUN_INSTALL_CACHE_DIR` | `bun/` | [Bun 全局缓存](https://bun.sh/docs/pm/global-cache) |
| `electron_config_cache`、`ELECTRON_CACHE` | `electron/` | [Electron 安装缓存](https://www.electronjs.org/docs/latest/tutorial/installation#cache)、[electron-builder 多平台构建](https://www.electron.build/docs/features/multi-platform-build/) |
| `ELECTRON_BUILDER_CACHE` | `electron-builder/` | [electron-builder 环境变量](https://www.electron.build/docs/environment-variables/) |
| `npm_config_cache`、`npm_config_devdir` | `npm/`、`node-gyp/` | npm/native 子进程缓存与 Node headers |
| `TMPDIR` | `tmp/<slot>/` | 构建临时文件 |
| `TURBO_CACHE_DIR` | `turbo/<slot>/` | Turbo 任务缓存 |
| `CLANG_MODULE_CACHE_PATH`、`SWIFT_MODULECACHE_PATH` | `clang/<slot>/`、`swift/<slot>/` | 桌面 native helper 的编译缓存 |

上游 `turbo.json` 没有列出全部缓存与 profile 变量，因此入口设置 `TURBO_ENV_MODE=loose`，让真实子任务收到它们（[Turbo run 文档](https://turborepo.dev/docs/reference/run#--env-mode-option)）。workspace 的编译产物、类型检查缓存和 `.electron-runtime` 仍在 checkout；这里不迁移上游目录。

运行采用现有 Cua 身份（`com.emanueledipietro.synara.cua`、`synara-cua://`），关闭自动更新。`SYNARA_HOME=instances/<slot>/home` 与 `SYNARA_DESKTOP_SMOKE_USER_DATA=instances/<slot>/electron-profile` 分别隔离 SQLite/设置和 Electron profile。依据是 `packages/shared/src/desktopIdentity.ts`、`apps/desktop/src/main.ts` 和 `apps/desktop/src/desktopUserDataProfile.ts` 的既有机制。入口保留用户 HOME，清除当前子进程继承的 Synara 远程连接、认证 token 与已有 renderer URL；不修改用户配置。启动前先查看 `--dry-run` 并核对 IPv4/IPv6 端口；只关闭自己启动的进程。

`A2A_SYNARA_SLOT` 是一个目录名，默认 `default`；不同实例应使用不同 slot。`SYNARA_BUILD_VOLUME` 仅用于显式选择另一外置挂载点或模拟缺盘，不自动创建挂载点。例如：

```sh
SYNARA_BUILD_VOLUME=/tmp/t034-not-mounted-volume ./a2a/scripts/bun install --frozen-lockfile
```

直接调用 Bun 会绕过本入口；本入口也不替任意后续命令禁止外部副作用。T-034 仅执行本地开发命令，不发布、不 push。
