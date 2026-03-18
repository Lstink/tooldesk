# 构建与发布说明

本文档说明如何本地构建、通过 GitHub Actions 发布版本，以及配置自动更新。

---

## 本地构建

```bash
# 安装依赖
pnpm install

# 开发模式
pnpm tauri dev

# 生产构建（生成当前平台安装包）
pnpm tauri build
```

构建产物在 `src-tauri/target/release/bundle/` 下（如 `.dmg`、`.msi`、`.deb` 等）。

### Windows 安装注意事项（WebView2）

- 当前 Windows 安装器使用 `embedBootstrapper` 模式，会在安装过程中联网拉取并安装 WebView2 Runtime。
- 建议在 Win10/11 上以管理员权限运行安装器，确保运行时写入与注册成功。
- 若安装时报错 `Failed to install WebView2`，先确认网络可访问微软下载源，再重试安装。
- 若仍失败，可先手动安装 Evergreen WebView2 Runtime，再重新运行应用安装器：  
  https://developer.microsoft.com/microsoft-edge/webview2/

---

## 发布与自动更新

应用已接入基于 GitHub Releases 的自动更新。按下面步骤完成一次发布并让用户端能检测到更新。

### 1. 生成更新签名密钥（仅首次）

在项目根目录执行：

```bash
pnpm tauri signer generate -w ~/.tauri/desktool.key
```

会生成私钥文件 `~/.tauri/desktool.key` 和同目录下的 `.pub` 公钥文件。**请妥善保管私钥，不要提交到仓库。**

### 2. 配置公钥到项目

打开 `src-tauri/tauri.conf.json`，将 `plugins.updater.pubkey` 的值改为**公钥文件中的完整内容**（不是文件路径）。公钥内容类似一行以 `dW50cnVzdGVk...` 开头的 Base64 字符串，可从 `~/.tauri/desktool.key.pub` 复制整行。

### 3. 配置 GitHub 仓库 Secrets

在 GitHub 仓库 **Settings → Secrets and variables → Actions** 中新增：

| Secret 名称 | 说明 |
|-------------|------|
| `TAURI_PRIVATE_KEY` | 私钥文件 `~/.tauri/desktool.key` 的**完整文件内容**（整段复制粘贴） |
| `TAURI_KEY_PASSWORD` | 生成密钥时若设置了密码则填该密码，否则留空 |

`GITHUB_TOKEN` 由 Actions 自动提供，无需手动添加。

### 4. 发布新版本（例如 v1.0.1）

发布前用脚本一键把三处版本号改为新版本，再提交并打 tag：

```bash
./scripts/bump-version.sh 1.0.1
# 或
./scripts/bump-version.sh v1.0.1

git add .
git commit -m "chore: bump to v1.0.1"
git tag -a v1.0.1 -m "优化更新弹窗与发布流程"
git push origin main
git push origin v1.0.1
```

如果需要多行更新说明，可用多条 `-m`（第一条是标题，后续是正文）：

```bash
git tag -a v1.0.1 \
  -m "v1.0.1" \
  -m "1) 更新检查发现新版本时直接弹窗" \
  -m "2) 更新弹窗显示 release notes"
```

建议同时更新 `CHANGELOG.md` 中对应版本节（如 `## [1.0.1]`）。工作流会优先读取该版本节作为 Release notes；若未找到，再回退到 tag 注释内容。

脚本会同步修改 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 中的版本号，避免遗漏。

推送 tag 后，GitHub Actions 会自动构建 macOS / Windows 安装包并创建 Release，同时上传 `latest.json` 和签名文件，供客户端检查更新使用。工作流会优先读取 **CHANGELOG.md 对应版本内容** 作为 Release 说明（也会进入更新 notes）；未命中时回退到 **tag 注释内容**。

### 5. 验证自动更新

1. 在本地安装当前已发布的版本（如 v1.0.0 的安装包）。
2. 发布一个更高版本（如 v1.0.1）到 GitHub Release（按上面步骤打 tag）。
3. 打开已安装的 v1.0.0 应用，点击「检查更新」或等待启动时自动检查，应能提示新版本并完成下载、安装与重启。

**注意**：`pubkey` 与构建时使用的私钥必须一致，否则更新校验会失败；版本号需严格递增且三处（Cargo.toml、tauri.conf.json、package.json）一致。
