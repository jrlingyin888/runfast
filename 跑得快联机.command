#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js。请先安装：https://nodejs.org （装 LTS 版即可），装好后再双击本文件。"
  read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi
echo "正在启动「跑得快」联机服务……（关闭本窗口 = 停止服务）"
node server.js
