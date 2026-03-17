# Changelog

All notable changes to this project are documented in this file.

The release workflow reads the section matching the pushed tag version
(`vX.Y.Z` -> `## [X.Y.Z]`) and uses that content as release notes.

## [Unreleased]

- 暂无

## [1.0.2] - 2026-03-17

- 更新检查改为发现新版本后直接弹窗，并在弹窗中展示更新内容。
- 修复自动更新源地址，确保从正确仓库获取 `latest.json` 和安装包。


## [1.0.1] - 2026-03-17

- 发布自动更新能力（Tauri Updater）。
- 优化更新交互：支持检测更新并安装。
