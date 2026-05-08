# AGENTS.md

本文件用于指导在本仓库内工作的 AI/自动化代理，确保改动可运行、可发布、可回滚。

## 1. 项目概览

- 项目名称：`desktool`
- 形态：Tauri 2 桌面应用（前端 React + TypeScript + Vite，后端 Rust）
- 当前版本：`1.1.1`（需与 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 保持一致）
- 主要功能：
  - 图片转 PDF（支持旋转、A4 适配）
  - 局域网文件传输（上传/下载模式）
  - 垃圾文件生成
  - 应用内更新检查（Tauri Updater）

## 2. 目录职责

- `src/`：前端 UI 与交互逻辑（React）
- `src-tauri/src/`：Rust 命令与本地能力实现
  - `pdf.rs`：图片转 PDF 核心逻辑
  - `lib.rs`：Tauri 命令注册、文件传输 HTTP 服务、垃圾文件生成等
- `src-tauri/tauri.conf.json`：Tauri 构建、窗口、Updater 配置
- `scripts/`：辅助脚本
  - `bump-version.sh`：同步更新三处版本号
  - `svg-to-icon.mjs`：SVG 转图标输入
- `.github/workflows/release.yml`：基于 tag 的自动发布工作流
- `CHANGELOG.md`：发布说明优先来源
- `RELEASE.md`：发布与自动更新操作说明

## 3. 本地开发命令

优先使用 `pnpm`。

```bash
pnpm install
pnpm tauri dev
pnpm tauri build
```

常用前端命令：

```bash
pnpm dev
pnpm build
pnpm preview
```

图标生成：

```bash
pnpm icon
```

## 4. 代码改动约定

- 保持改动最小化，优先修复根因，避免无关重构。
- 前端改动集中在 `src/`；Rust 能力改动集中在 `src-tauri/src/`。
- 涉及命令参数或返回结构变更时，必须同步检查 TS 类型与 Rust 序列化字段。
- 维持现有错误提示风格（中文用户可读信息）。
- 不要提交密钥、签名私钥或本机路径信息。

## 5. 版本与发布约束（重要）

发布前版本号必须三处一致：

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

建议使用：

```bash
./scripts/bump-version.sh 1.2.3
```

发布通过 push tag 触发：

- tag 格式：`v*`（如 `v1.2.3`）
- 工作流：`.github/workflows/release.yml`
- 平台：macOS（arm64/x64）+ Windows
- Release Notes：优先取 `CHANGELOG.md` 对应版本节，其次取 tag 注释

## 6. Updater 相关注意事项

- `src-tauri/tauri.conf.json` 中 `plugins.updater.pubkey` 必须与发布签名私钥匹配。
- `plugins.updater.endpoints` 当前指向 GitHub Releases `latest.json`。
- 若出现“可检查到更新但安装失败”，优先排查：
  - 版本号是否递增
  - 签名密钥是否匹配
  - Release 资产是否完整上传

## 7. Windows 打包注意

当前配置：`webviewInstallMode.type = embedBootstrapper`。
安装阶段会联网安装 WebView2；若失败，按 `RELEASE.md` 指引先安装 Evergreen WebView2 Runtime。

## 8. 提交前最小检查清单

1. `pnpm build` 通过。
2. 如改到 Rust/Tauri 能力，至少执行一次 `pnpm tauri build` 或 `pnpm tauri dev` 验证。
3. 不包含密钥、证书、私人配置。
4. 若涉及发布，确认版本号与 `CHANGELOG.md` 已同步。

## 9. 适合代理执行的任务

- UI 文案/交互修复
- 图片转 PDF 行为优化与 bug 修复
- 文件传输页面与后端接口联调
- 发布流程脚本化改进（不触碰密钥本体）

## 10. 不应自动执行的高风险操作

- 直接覆盖/轮换 updater 签名密钥
- 未经确认直接发布正式 tag
- 大规模删除 `src-tauri/icons/` 或构建配置

如需调整发布链路（workflow、签名、updater endpoint），先在 PR 描述中列出风险与回滚方案。
