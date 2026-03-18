#!/usr/bin/env bash
# 一键修改项目版本号（同步 package.json、Cargo.toml、tauri.conf.json）
# 用法:
#   ./scripts/bump-version.sh -v
#   ./scripts/bump-version.sh 1.0.1
#   ./scripts/bump-version.sh v1.0.1

set -e
cd "$(dirname "$0")/.."

get_current_version() {
  sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -n 1
}

if [ "$1" = "-v" ]; then
  CUR_VER="$(get_current_version)"
  if [ -z "$CUR_VER" ]; then
    echo "错误: 无法从 package.json 读取当前版本号"
    exit 1
  fi
  echo "$CUR_VER"
  exit 0
fi

if [ -z "$1" ]; then
  echo "用法: $0 -v | <新版本号>"
  echo "示例: $0 -v  或  $0 1.0.1  或  $0 v1.0.1"
  exit 1
fi

VER="${1#v}"   # 去掉开头的 v
if ! [[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "错误: 版本号须为语义化版本，如 1.0.1"
  exit 1
fi

echo "正在将版本号统一改为: $VER"
echo ""

# 通用 sed 替换（兼容 macOS 与 Linux）
apply_sed() {
  local file="$1"
  local pattern="$2"
  local replacement="$3"
  if [ -f "$file" ]; then
    sed "s/$pattern/$replacement/" "$file" > "${file}.tmp" && mv "${file}.tmp" "$file"
    echo "  ✓ $file"
  fi
}

# package.json
apply_sed package.json "\"version\": \"[^\"]*\"" "\"version\": \"$VER\""

# src-tauri/Cargo.toml（只改 [package] 下的 version，匹配 x.y.z）
apply_sed src-tauri/Cargo.toml "^version = \"[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\"" "version = \"$VER\""

# src-tauri/tauri.conf.json
apply_sed src-tauri/tauri.conf.json "\"version\": \"[^\"]*\"" "\"version\": \"$VER\""

echo ""
echo "版本号已全部更新为 ${VER}. 发布时记得: git tag v${VER} && git push origin v${VER}"
