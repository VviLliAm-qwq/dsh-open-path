# dsh-open-path

`/open` — 用系统默认程序打开文件、用资源管理器打开文件夹，支持路径直达与工作区模糊搜索。

dsh-TUI 生态插件（Community v0.15 manifest），MIT 许可。

## 能力

- **`/open`**（无参数）→ 在系统资源管理器中打开**当前会话工作目录**
- **`/open src/index.ts`** → 打开存在的相对路径 / 绝对路径
- **`/open readme`** → 模糊搜索当前工作区（文件名/目录名，中文与大小写不敏感）
  - 唯一命中 → 直接打开
  - 多个命中 → 托管对话框（TUI 接缝十）列出候选，↑/↓ 选择，Enter 打开，Esc 取消
  - 零命中 → 明确报错：`工作区中找不到与 “…” 相关的文件或文件夹`
- 目录命中 → 资源管理器打开该目录；文件命中 → 关联的默认程序打开

## 安装

```sh
# 打包发布后（npm 名称：dsh-open-path）
dsh plugin --profile dsh-tui add dsh-open-path

# 本仓库本地安装（开发）
pnpm install --frozen-lockfile && pnpm build
cd ~/.dsh/profiles/dsh-tui && pnpm add <本仓库路径>
# 并把 dsh-open-path 加入 package.json 的 dsh.profile.bundles
```

安装后需在 TUI 内 `/restart`（或重开窗口）生效。

## 兼容性

- **依赖下限**：`@deepseek-harness-tui/dsh-tui >= 0.10.0-beta.5`（命令注册面 C-041 托管面 + 回退；托管对话框为「稳定候选」接缝）
- **Manifest**：Community v0.15（`commands.dsh/v1alpha1#Command` 必需；`commands.invoke` 已声明，默认允许、可经授权文件 `denies` 撤销）
- **命令注册**：优先 `ctx.tuiPluginHost.registerCommand`（C-041 归属 + invoke 检查点）；宿主未提供时回退到直接 `commands` 服务（C-070 边界，功能等效但无归属印记）
- **对话框**：`ctx.get('tuiDialogs', false)` 软探测（#183 纪律）；服务缺失时降级为清晰报错并列出候选，绝不崩溃、不影响 TUI 启动
- **零依赖污染**：不 import 上游包类型（结构式最小接口），上游版本漂移不会破坏本插件
- **平台**：Windows 完全支持（目录经 `Shell.Application` COM 通道，是单实例 Explorer 上唯一可靠的打开方式）；macOS/Linux 走 `open`/`xdg-open`

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `maxCandidates` | `10` | 选择框最多展示的候选数（1–50） |
| `includeHidden` | `false` | 是否索引隐藏（点开头）文件/目录 |

配置经 `/settings` 或 profile 的 cordis 配置覆盖；所有键都有默认值，缺失时降级为默认行为。

## 工作目录语义

命令以**接收会话的工作目录**（`agent.session.meta.cwd`）为基准，而非进程 cwd——在 TUI 里 `/workspace` 切换目录后 `/open` 依然跟手；极端情况下（无会话 cwd 信息）回退到进程启动目录。

## Model Experience

命令在 UI 命令平面执行，结果文本由适配器直接渲染：**不产生模型消息、不计入模型 token、不进入模型 KV 缓存**。`command/run` / `command/done` 仅以 log-only 事件记录到会话日志。

## Known Limitations

- 模糊索引受深度（≤6 层）、条目数（≤20000）上限约束；超大仓库下扫描在取消信号/上限处截止，超出的部分不被检索。
- 打开目标是文件但系统无关联程序时，行为由系统决定（Windows 可能弹出「如何打开」对话框）——保持平台默认，不擅自选择程序。
- 无图形会话的环境（headless Linux）会明确报错，不静默失败。
- 打开动作是 fire-and-forget：系统处理请求启动成功即返回成功，不等待目标程序加载完成。

## 发布

- **仓库**：<https://github.com/VviLliAm-qwq/dsh-open-path>（公开）
- **版本**：语义化版本；发布由 `v*` tag 驱动（`.github/workflows/release.yml`：校验 tag 与 package.json 版本一致 → build/test/校验 → `npm publish --provenance` → GitHub Release）
- **前置**：仓库 Secrets 需配置 `NPM_TOKEN`（npm 发布令牌）；npm 名称 `dsh-open-path` 需确认未被占用

## 开发与验证

```sh
pnpm install
pnpm build             # tsc -> lib/
pnpm test              # vitest
pnpm validate:manifest # dsh-plugin.json 准入形状检查
pnpm pack:verify       # 发布包布局检查
pnpm prepublishOnly    # 四合一
```

## License

[MIT](LICENSE)
