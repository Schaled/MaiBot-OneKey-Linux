# MaiBot OneKey — Linux 移植（linux-port 分支）

P1（headless）与 P2（Electron 桌面）均已完成并通过实机验收。

## 架构

```
src/main/platform/     平台抽象层（无 electron 依赖）
  runtime-paths.ts       buildRuntimePaths() 纯函数；Electron 与 CLI 共用
  process-controller.ts  killTree/listProcesses（win32: taskkill+PowerShell, POSIX: /proc + 进程组）
  pipe-transport.ts      headless 会话传输（detached 进程组，stop=SIGINT 组信号）
  pty-transport.ts       node-pty 传输（P2 用；懒加载，headless 不触碰）
  payload-manager.ts     python-build-standalone + SnowLuma 供给（sha256 固定）
  artifact-fetch.ts      双传输（fetch + curl 兜底）下载器；镜像只改路径，hash 是唯一信任根
src/cli/               headless 入口
  main.ts                maibot-ok 命令分发
  bootstrap.ts           与 src/main/index.ts 相同的服务对象图（注入 headless 实现）
  control-socket.ts      UDS 换行 JSON 协议（请求/响应/流式帧）
scripts/linux/         payload 组装与安装脚本
scripts/tests/linux/   P1 冒烟验收套件（bun test）
```

目录布局：

| 内容 | 路径 |
|---|---|
| payload（runtime/ modules/ cli/） | 仓库根（开发）或 `~/.local/share/maibot-onekey/payload`（安装） |
| 实例（config/ data/ modules/） | `--root`，默认 `~/.local/share/maibot-onekey/instance` |
| 启动器设置 | `$XDG_CONFIG_HOME/MaiBotOneKeyDesktop/<sha256(payload)[:12]>` |
| 控制 socket | `$XDG_RUNTIME_DIR/maibot-onekey/<scope>.sock` |

## 快速开始

```bash
bun install
bun run payload:linux        # 下载 python-build-standalone 3.12.16 + SnowLuma 2.1.1，构建 CLI bundle
bash scripts/linux/install.sh  # 可选：装到 ~/.local/share 并写入 ~/.local/bin/maibot-ok

# 开发模式直接跑：
bun src/cli/main.ts eula --accept
bun src/cli/main.ts install          # 建 Python 环境 + pip 装 maibot（最新正式版）
bun src/cli/main.ts backend snowluma install
bun src/cli/main.ts serve            # 前台 supervisor（或任何 start 命令自动拉起后台）
bun src/cli/main.ts start maibot
curl -I http://127.0.0.1:8001/       # WebUI 就绪后浏览器打开
```

## 命令一览

`serve start stop restart status logs install rollback versions eula doctor backup restore backend shutdown`，加 `--json` 输出机器可读结果，`--root` 指定实例目录。

## 验收

```bash
MAIBOT_SMOKE_FULL=1 bun run test:linux
```

覆盖：doctor JSON、EULA 门禁、完整安装（真实 PyPI）、start → WebUI 8001 HTTP 200、停止后无孤儿进程、kill -9 自愈、备份/恢复往返、NapCat compose 生成、SnowLuma 落地可运行。

**真机 QQ 登录不在自动验收内**，步骤：

1. `maibot-ok backend snowluma install`（或 NapCat：`backend napcat compose && backend napcat up`，需要 docker 组权限）
2. `maibot-ok start napcat` 后打开 `http://127.0.0.1:5099`（SnowLuma WebUI，密码见 `status` 日志）扫码登录
3. 在 `http://127.0.0.1:8001` 配置模型 Key，观察日志 `maibot-ok logs maibot -f`

## 已知偏差（相对 Windows 版）

- 不打包 git（用系统 git，`doctor` 检测）；不打包 Node（SnowLuma 自带 node 24.22.1）
- SnowLuma 不进仓库/payload：首次按需下载（gh-proxy 优先，官方 Release 兜底，sha256 固定）
- NapCat 仅 Docker 路线；npm 包已全部 unpublished，注入 `/opt/QQ` 未实现
- 无 GUI：悬浮窗、托盘、嵌入式终端、外观设置属 P2
- `debug.enable_console_input` 在 headless 下始终被跳过（stdin 非 TTY），与 Windows 版外置终端行为一致

## 与上游同步

`git remote add upstream https://github.com/Mai-with-u/MaiBotOneKey && git fetch upstream && git merge upstream/main`。
平台差异集中在 `src/main/platform/` 与 `src/cli/`（新增文件），上游文件只留注入点小改。

## P2：Electron 桌面（已完成）

```bash
bun run release:linux     # 构建 + 打包 AppImage/deb（含 node-pty 对 Electron ABI 重编译）
```

产物：`release/MaiBot-OK-0.7.3-linux.AppImage` / `.deb`（约 197MB / 149MB）。

与 Windows 打包的差异：
- node-pty 无 linux 预编译：构建时用 `@electron/rebuild` 对 Electron 38.8.6 的 ABI 重编（官方 headers 源；npmmirror 的 headers 包校验和不匹配，勿用 --dist-url）
- 不打包含 git（系统 git）与 Node（SnowLuma 自带 node 24.22.1）
- SnowLuma 不进 payload：GUI 启动/repair 时按需下载（gh-proxy 优先，sha256 固定，清单来自 resources/snowluma-upstream.json）
- QQ 后端默认值：无内置 napcat 模板时默认 snowluma（`protocol-backend-manager.ts`）
- 更新：复用既有 `.AppImage` 资产选择；下载后 `chmod 755` 再 `shell.openPath`
- 无内置 QQ 组件时跳过启动器更新后的组件自动升级（`index.ts`）

实机验收（KDE X11）：打包应用启动 → 协议确认 → repair 自动装 maibot 1.3.19 + 下载 SnowLuma → 内嵌 WebUI 设置向导渲染（127.0.0.1:8001/setup）→ 服务进程树正常。

注意：直接运行 `linux-unpacked/` 需 `--no-sandbox`（chrome-sandbox 属主限制）；deb/AppImage 分发形态自动处理。
