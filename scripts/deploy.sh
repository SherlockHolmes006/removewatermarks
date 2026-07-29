#!/usr/bin/env bash
# 在云服务器上执行：拉取最新代码 → 构建 → 同步到 Nginx 站点目录
# 用法：
#   chmod +x scripts/deploy.sh
#   ./scripts/deploy.sh
# 或指定站点目录：
#   WEB_ROOT=/var/www/remove-watermark ./scripts/deploy.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WEB_ROOT="${WEB_ROOT:-/var/www/remove-watermark}"
BRANCH="${BRANCH:-main}"

cd "$ROOT_DIR"

echo "==> 拉取最新代码 ($BRANCH)"
git fetch origin
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

echo "==> 安装依赖并构建"
npm ci
npm run build

DIST_DIR="$ROOT_DIR/apps/web/dist"
if [[ ! -f "$DIST_DIR/index.html" ]]; then
  echo "错误：构建产物不存在: $DIST_DIR/index.html"
  exit 1
fi

echo "==> 同步到站点目录: $WEB_ROOT"
sudo mkdir -p "$WEB_ROOT"
sudo rsync -a --delete "$DIST_DIR/" "$WEB_ROOT/"

echo "==> 部署完成"
echo "    源码: $ROOT_DIR @ $(git rev-parse --short HEAD)"
echo "    站点: $WEB_ROOT"
