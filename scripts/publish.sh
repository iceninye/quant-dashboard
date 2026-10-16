#!/usr/bin/env bash
# publish.sh — 每日同步 + 重建 + 檢查 + push（唔用 cron，手動或由 agent 觸發）
set -euo pipefail
cd "$(dirname "$0")/.."
DAYS="${1:-120}"
echo "=== 1/4 sync（最近 $DAYS 日）==="; node scripts/sync.mjs --days="$DAYS"
echo "=== 2/4 build ==="; node scripts/build.mjs | tail -5
echo "=== 3/4 check ==="; node scripts/check.mjs | tail -3
echo "=== 4/4 push ==="
if [ -z "$(git status --porcelain)" ]; then echo "冇變動 → 唔 push"; exit 0; fi
git add -A
git commit -q -m "data: $(date +%F) 每日同步"
git push -q origin HEAD:main
echo "已 push → https://iceninye.github.io/quant-dashboard/"
