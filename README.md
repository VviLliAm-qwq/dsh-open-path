# dsh-open-path

`/open` — 用系统默认程序打开文件与 http(s) 链接、用文件管理器打开文件夹，支持路径直达、URL 直达与工作区模糊搜索。

> [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) · 一个为 dsh-TUI 生态打造的插件

dsh-TUI 生态插件（Community v0.15 manifest），MIT 许可。支持 Windows / macOS / Linux（含 WSL）。

## 能力

- **`/open`**（无参数）→ 在系统文件管理器中打开**当前会话工作目录**
- **`/open https://example.com`** → 用默认浏览器/处理程序打开 http(s) 链接（大小写不敏感；仅放行 http/https，`file:`/`ftp:`/`javascript:` 等协议会明确报错拒绝）
- **`/open github.com`** → 裸域名自动补全协议：域名补 `https://`，`localhost:5173`/`127.0.0.1:8080` 补 `http://`（本地开发）；工作区内**同名真实文件优先**；常见文件扩展名（`.md`/`.ts`/`.json`…）不会被误判为域名
- **`/open src/index.ts`** → 打开存在的相对路径 / 绝对路径
- **`/open ~/docs`** → `~` / `~/…` 展开为主目录（`~user` 不展开）
- **`/open readme`** → 模糊搜索当前工作区（文件名/目录名，中文与大小写不敏感，Unicode NFD/NFC 归一化）
  - 唯一命中 → 直接打开
  - 多个命中 → 托管对话框（TUI 接缝十）列出候选，↑/↓ 选择，Enter 打开，Esc 取消
  - 零命中 → 明确报错：`工作区中找不到与 “…” 相关的文件或文件夹`
- 目录命中 → 文件管理器打开该目录；文件命中 → 关联的默认程序打开

## 安装

```sh
# 从 npm 安装（名称：dsh-open-path）
dsh plugin --profile dsh-tui add dsh-open-path

# 本仓库本地安装（开发）
pnpm install --frozen-lockfile && pnpm build
cd ~/.dsh/profiles/dsh-tui && pnpm add <本仓库路径>
# 并把 dsh-open-path 加入 package.json 的 dsh.profile.bundles
```

安装后需在 TUI 内 `/restart`（或重开窗口）生效。

## 平台支持

打开动作按**有序启动器链**执行：链上第一个能成功启动（且未在宽限窗口内非 0 退出）的候选胜出，否则自动回退下一个；整链失败时明确报错并列出已尝试的启动器。

| 平台 | 文件夹 | 文件 / http(s) 链接 | 备注 |
|---|---|---|---|
| **Windows** | `Shell.Application` COM，回退 `cmd /c start` | `cmd /d /s /c start "" "<目标>"` | 单实例 Explorer 会吞掉 `start <目录>` 请求，COM 通道是唯一可靠的文件夹打开方式；该 COM 子进程**不能** detached（无控制台的 PowerShell 会丢调用），仅 `windowsHide` |
| **macOS** | `open` | `open` | 文件名 NFD（磁盘）/NFC（键入）差异已在匹配层归一化 |
| **Linux** | `xdg-open` → `gio open` → `kde-open5` → `kde-open` → `exo-open` | 同左 | 需装其中任一（多数发行版带 `xdg-utils`）；三者都处理文件、目录与 URL |
| **WSL** | `wslview` → 上述 Linux 链 | `wslview` → 上述链 → `cmd.exe /c start` | 没有 WSLg（无 `DISPLAY`/`WAYLAND_DISPLAY`）也判定为可用图形会话，改走 Windows 侧处理程序 |

失败判定不是"进程起来了就算成功"：启动器无法 spawn（如未安装 `xdg-open` → ENOENT）或快速非 0 退出（无关联程序）都会被识别并触发回退；目标路径本身不存在时直接明确报错，不会谎报 `已打开`。

## 兼容性

- **依赖下限**：`@deepseek-harness-tui/dsh-tui >= 0.10.0-beta.5`（命令注册面 C-041 托管面 + 回退；托管对话框为「稳定候选」接缝）
- **Manifest**：Community v0.15（`commands.dsh/v1alpha1#Command` 必需；`commands.invoke` 已声明，默认允许、可经授权文件 `denies` 撤销）
- **命令注册**：优先 `ctx.tuiPluginHost.registerCommand`（C-041 归属 + invoke 检查点）；宿主未提供时回退到直接 `commands` 服务（C-070 边界，功能等效但无归属印记）
- **对话框**：`ctx.get('tuiDialogs', false)` 软探测（#183 纪律）；服务缺失时降级为清晰报错并列出候选，绝不崩溃、不影响 TUI 启动
- **诊断日志**：`~/.dsh-tui/dsh-open-path.log` —— 模块导入 / `apply` 开始 / 接缝探测（`tuiPluginHost`·`commands`·`tuiDialogs` 各 0/1）/ 注册结果 / 卸载各一行，超 128 KiB 裁剪保留最新一半；测试运行与 `node --test` 下不写
- **零依赖污染**：不 import 上游包类型（结构式最小接口），上游版本漂移不会破坏本插件；也不复用 TUI 内部私有模块
- **无图形会话**：Windows/macOS 恒可用；Linux 需 `DISPLAY`/`WAYLAND_DISPLAY`；WSL 例外（走 Windows 侧）。不可用时明确报错而非静默失败
- **CI**：`ubuntu-latest` / `windows-latest` / `macos-latest`（Node 24，另加 Ubuntu × Node 22 覆盖 engines 下限）

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `maxCandidates` | `10` | 选择框最多展示的候选数（1–50） |
| `includeHidden` | `false` | 是否索引隐藏（点开头）文件/目录 |

配置经 `/settings` 或 profile 的 cordis 配置覆盖；所有键都有默认值，缺失时降级为默认行为。

## 工作目录语义

命令以**接收会话的工作目录**（`agent.session.header.cwd`，DSH 会话头记录的 host-side cwd）为基准，而非进程 cwd——TUI 里 `/workspace` 切换会新建会话，新会话头即新目录，所以 `/open` 始终跟手；极端情况下按 `session.meta.cwd`（旧版宿主别名）→ 进程启动目录依次回退。

模糊索引的相对路径统一以 `/` 分隔（Windows 下同样成立），因此同一份索引在三个平台语义一致。

## Model Experience

命令在 UI 命令平面执行，结果文本由适配器直接渲染：**不产生模型消息、不计入模型 token、不进入模型 KV 缓存**。`command/run` / `command/done` 仅以 log-only 事件记录到会话日志。

## Known Limitations

- 只接受 `http://` / `https://` 链接（含裸域名自动补全）；`file:`、`ftp:`、`javascript:`、`mailto:` 等其它协议明确报错拒绝，不会交给系统处理。裸域名猜测豁免常见文件扩展名（`.md`/`.ts`/`.json` 等按文件处理），单字符 TLD（如 `a.b`）与版本号（`v2.0.1`）也不会被当作网址。
- 模糊索引受深度（≤6 层）、条目数（≤20000）上限约束；超大仓库下扫描在取消信号/上限处截止，超出的部分不被检索。
- 指向目录的符号链接会被索引为目录，但**不会被递归遍历**（防环、防越出工作区）。
- `~` 展开仅支持 `~` / `~/…` / `~\…`，不解析 `~user`（无 passwd 查询）。
- 打开目标是文件但系统无关联程序时，行为由系统决定（Windows 可能弹出「如何打开」对话框）——保持平台默认，不擅自选择程序。
- 打开动作仍是 fire-and-forget：只在 180ms 宽限窗口内观测失败并回退，之后不再等待目标程序加载完成；窗口后仍崩溃的启动器不会被察觉。
- `xdg-open` 在部分桌面环境会阻塞到应用退出——本插件不受影响（宽限窗口后即视为已打开）。

## 发布

- **仓库**：<https://github.com/VviLliAm-qwq/dsh-open-path>（公开）
- **版本**：语义化版本；发布由 `v*` tag 驱动（`.github/workflows/release.yml`：校验 tag 与 package.json 版本一致 → build/test/校验 → `npm publish --provenance` → GitHub Release）
- **前置**：仓库 Secrets 需配置 `NPM_TOKEN`（npm 发布令牌）；npm 名称 `dsh-open-path` 需确认未被占用
- **生态收录**：按 <https://dshtui.com/plugins/> 的收录要求，本 README 顶部带有 dsh-TUI 链接（该站给出的固定写法：`[dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) · 一个为 dsh-TUI 生态打造的插件`）

## 开发与验证

```sh
pnpm install
pnpm build             # tsc -> lib/
pnpm test              # vitest（平台分支通过注入 platform/env 实现跨平台覆盖）
pnpm validate:manifest # dsh-plugin.json 准入形状检查
pnpm pack:verify       # 发布包布局检查
pnpm prepublishOnly    # 四合一
```

## License

[MIT](LICENSE)
