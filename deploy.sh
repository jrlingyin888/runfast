#!/bin/bash
# 本机一键：重建 dist + 提交 + 推送到 GitHub。
# 用法： bash deploy.sh "这次改了啥的简单说明"
# 推完后到服务器跑： bash /www/wwwroot/runfast/update.sh   （或直接让 Claude 上线）
set -e
cd "$(dirname "$0")"
MSG="${1:-update}"

echo "== 1/3 重建 dist（前端改动必须） =="
node build.js

echo "== 2/3 提交 =="
git add -A
if git diff --cached --quiet; then
  echo "没有需要提交的改动，跳过。"
else
  git commit -m "$MSG"
fi

echo "== 3/3 推送到 GitHub =="
git push

echo ""
echo "✅ 已推送到 GitHub。"
echo "   接着到服务器（宝塔终端）跑： bash /www/wwwroot/runfast/update.sh"
echo "   或者直接跟 Claude 说「帮我上线」。"
