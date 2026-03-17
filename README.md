# Desktool 图片转 PDF

基于 Tauri 2 + React + TypeScript + Vite 的桌面应用，支持将多张图片合并导出为 PDF。

---

## 功能特性

- **图片转 PDF**：选择多张图片，一键合并为单个 PDF 文件
- **图片旋转**：在导出前可对每张图片进行旋转
- **A4 适配**：可选按 A4 页面尺寸适配，图片居中缩放
- **多格式支持**：支持 PNG、JPG、JPEG、WebP、BMP、GIF、TIFF 等常见图片格式
- **亮色 / 暗色主题**：支持亮色、暗色及跟随系统主题
- **自动更新**：内置更新检查与安装（需配置 Tauri Updater）

---

## 技术栈

- **前端**：React 19、TypeScript、Vite 7
- **桌面壳**：Tauri 2
- **后端**：Rust（printpdf、image、serde 等）
- **插件**：Tauri 插件：dialog、fs、opener、process、updater

---

## 环境要求

- [Node.js](https://nodejs.org/)（建议 LTS）
- [pnpm](https://pnpm.io/)（项目使用 pnpm 作为包管理器）
- [Rust](https://www.rust-lang.org/)（Tauri 2 所需）
- 各平台 Tauri 依赖（见 [Tauri 文档](https://v2.tauri.app/start/prerequisites/)）

---

## 快速开始

```bash
# 安装依赖
pnpm install

# 开发模式（热重载）
pnpm tauri dev

# 构建生产版本
pnpm tauri build
```

构建产物位于 `src-tauri/target/release/`（或 `target/debug/` 对应调试构建）。

---

## 项目结构

```
desktool/
├── src/                 # 前端源码（React + Vite）
│   ├── App.tsx
│   └── ...
├── src-tauri/           # Tauri 后端
│   ├── src/
│   │   ├── lib.rs
│   │   ├── pdf.rs       # 图片转 PDF 逻辑
│   │   └── ...
│   ├── Cargo.toml
│   └── tauri.conf.json
├── package.json
└── README.md
```

---

## 推荐 IDE 配置

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

---

## 许可证

按项目根目录或仓库中声明的许可证使用。

---

# Desktool — Image to PDF

A desktop app built with **Tauri 2**, **React**, **TypeScript**, and **Vite**. Merge multiple images into a single PDF file.

---

## Features

- **Image to PDF**: Select multiple images and export them as one PDF
- **Image rotation**: Rotate each image before export
- **A4 fit**: Optionally fit content to A4 page size with centered scaling
- **Multiple formats**: PNG, JPG, JPEG, WebP, BMP, GIF, TIFF, and more
- **Light / dark theme**: Light, dark, or follow system preference
- **Auto-update**: Built-in update check and install (requires Tauri Updater configuration)

---

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite 7
- **Desktop shell**: Tauri 2
- **Backend**: Rust (printpdf, image, serde, etc.)
- **Plugins**: Tauri plugins — dialog, fs, opener, process, updater

---

## Prerequisites

- [Node.js](https://nodejs.org/) (LTS recommended)
- [pnpm](https://pnpm.io/) (package manager used in this project)
- [Rust](https://www.rust-lang.org/) (required for Tauri 2)
- Platform-specific dependencies for Tauri ([Tauri docs](https://v2.tauri.app/start/prerequisites/))

---

## Quick Start

```bash
# Install dependencies
pnpm install

# Run in development (hot reload)
pnpm tauri dev

# Build for production
pnpm tauri build
```

Output is under `src-tauri/target/release/` (or `target/debug/` for debug builds).

---

## Project Structure

```
desktool/
├── src/                 # Frontend (React + Vite)
│   ├── App.tsx
│   └── ...
├── src-tauri/           # Tauri backend
│   ├── src/
│   │   ├── lib.rs
│   │   ├── pdf.rs       # Image-to-PDF logic
│   │   └── ...
│   ├── Cargo.toml
│   └── tauri.conf.json
├── package.json
└── README.md
```

---

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

---

## License

See the license specified in the project root or repository.
