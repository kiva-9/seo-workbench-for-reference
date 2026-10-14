#!/bin/zsh
# 双击启动脚本
cd "$(dirname "$0")" || exit 1

# 依次找 node：PATH -> Homebrew(Apple 芯片) -> Homebrew(Intel) / 官方安装包
NODE_BIN="$(command -v node 2>/dev/null)"
for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
  [ -n "$NODE_BIN" ] && break
  [ -x "$candidate" ] && NODE_BIN="$candidate"
done

if [ -z "$NODE_BIN" ]; then
  echo "没有找到 Node.js。"
  echo "请到 https://nodejs.org 安装 Node.js 24 后再双击本文件。"
  echo ""
  read -r "?按回车键关闭…"
  exit 1
fi

exec "$NODE_BIN" server.js
