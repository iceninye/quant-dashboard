#!/usr/bin/env bash
# run_local_validation.sh — 一鍵跑晒「搵最大獲利機會」所需嘅驗證（只讀，唔改 repo 數據、唔 push）
#
# 用法：
#   bash analysis/run_local_validation.sh --hk-prices <HK prices_*.csv> --us-prices <US prices_*.csv>
# 可選：
#   --hk-metrics DIR   預設 ~/hermes-projects/quant-hk/output/data
#   --us-metrics DIR   預設 ~/hermes-projects/quant-us/output/data
#   --period 6y        yfinance 下載長度（預設 6y）
#   --no-download      唔用 yfinance，只用你畀嘅 prices 檔
#
# 輸出：results/local-<日期>/（已喺 .gitignore，publish.sh 唔會 commit 佢）
#   SUMMARY.md  ← 將呢個檔（或者成個資料夾嘅 .tar.gz）上載返嚟 thread
set -uo pipefail
cd "$(dirname "$0")/.."

HK_PRICES=""; US_PRICES=""; PERIOD="6y"; DOWNLOAD=1
HK_METRICS="$HOME/hermes-projects/quant-hk/output/data"
US_METRICS="$HOME/hermes-projects/quant-us/output/data"
while [ $# -gt 0 ]; do
  case "$1" in
    --hk-prices) HK_PRICES="$2"; shift 2;;
    --us-prices) US_PRICES="$2"; shift 2;;
    --hk-metrics) HK_METRICS="$2"; shift 2;;
    --us-metrics) US_METRICS="$2"; shift 2;;
    --period) PERIOD="$2"; shift 2;;
    --no-download) DOWNLOAD=0; shift;;
    *) echo "唔識：$1"; exit 2;;
  esac
done

OUT="results/local-$(date +%Y%m%d-%H%M)"
mkdir -p "$OUT"
LOG="$OUT/run.log"
SUM="$OUT/SUMMARY.md"
FAIL=0
section() { awk -v s="=== $1 ===" '$0==s{f=1;next} /^=== /{f=0} f' "$LOG"; }   # 攞某一步嘅輸出
step() { echo; echo "=== $* ===" | tee -a "$LOG"; }
run() {  # run <label> <cmd...>：記錄輸出同結果，失敗都繼續
  local label="$1"; shift
  if "$@" >>"$LOG" 2>&1; then echo "✓ $label" | tee -a "$SUM"; else echo "✘ $label（exit $?，見 run.log）" | tee -a "$SUM"; FAIL=$((FAIL+1)); fi
}

{
  echo "# 本機驗證 $(date '+%F %T')"
  echo
  echo "- repo: $(git rev-parse --short HEAD) $(git status --porcelain | wc -l | tr -d ' ') 個未 commit 改動"
  echo "- python: $(python3 -c 'import sys,pandas,numpy;print(sys.version.split()[0],"pandas",pandas.__version__,"numpy",numpy.__version__)' 2>&1)"
  echo "- yfinance: $(python3 -c 'import yfinance;print(yfinance.__version__)' 2>/dev/null || echo 冇)"
  echo "- HK prices: ${HK_PRICES:-（冇畀）}；US prices: ${US_PRICES:-（冇畀）}"
  echo
  echo "## 1. 自測"
} > "$SUM"

step "1. 自測"
run "opportunity_scan 自測" python3 analysis/opportunity_scan.py --selftest
run "wfo_lowmdd 自測" python3 analysis/wfo_lowmdd_standalone.py --selftest
run "Dashboard check.mjs" node scripts/check.mjs

echo -e "\n## 2. Universe（倖存者偏差）" >> "$SUM"
for M in hk us; do
  MET_VAR="$(echo "$M" | tr a-z A-Z)_METRICS"; MET="${!MET_VAR}"
  step "2. universe $M"
  if [ -d "$MET" ]; then
    ARGS=(--metrics "$MET" --metrics "data/$M" --market "$M" --out "$OUT/universe-$M")
    [ "$DOWNLOAD" = 1 ] && ARGS+=(--download --period "$PERIOD")
    run "build_universe $M" python3 analysis/build_universe.py "${ARGS[@]}"
  else
    run "build_universe $M（只用 repo 名單，搵唔到 $MET）" python3 analysis/build_universe.py --metrics "data/$M" --market "$M" --out "$OUT/universe-$M"
  fi
  section "2. universe $M" | grep -E "^名單日數|下載|已寫|跌出名單" | sed 's/^/    /' >> "$SUM"
done

echo -e "\n## 3. 多因子機會掃描" >> "$SUM"
scan() {  # scan <market> <label> <prices> [extra args]
  local M="$1" L="$2" F="$3"; shift 3
  [ -f "$F" ] || { echo "- 略過 $M/$L（冇 $F）" >> "$SUM"; return; }
  step "3. scan $M $L"
  run "scan $M $L" python3 analysis/opportunity_scan.py --prices "$F" --market "$M" --out "$OUT/scan-$M-$L" "$@"
  if [ -f "$OUT/scan-$M-$L/report.md" ]; then
    { echo; echo "### $M / $L"; echo; sed -n '1,6p' "$OUT/scan-$M-$L/report.md"
      echo; echo "Top 8：（完整表見 scan-$M-$L/report.md）"; echo
      awk '/^## 全部檢定/{f=1;next} /^## /{f=0} f' "$OUT/scan-$M-$L/report.md" | sed -n '2,11p'
      awk '/^## 跟「到目前為止最好」/{f=1} /^## 今日名單/{f=0} f' "$OUT/scan-$M-$L/report.md"
      awk '/^## 今日名單/{f=1} /^## 注意/{f=0} f' "$OUT/scan-$M-$L/report.md"; } >> "$SUM"
  fi
}
scan hk today-list "$HK_PRICES"
scan us today-list "$US_PRICES"
scan hk union "$OUT/universe-hk/prices_union.csv"
scan hk union-pit "$OUT/universe-hk/prices_union.csv" --membership "$OUT/universe-hk/membership.csv"
scan us union "$OUT/universe-us/prices_union.csv"
scan us union-pit "$OUT/universe-us/prices_union.csv" --membership "$OUT/universe-us/membership.csv"

echo -e "\n## 4. 低 MDD walk-forward（同 docs/WFO.md 一樣做法，方便對照）" >> "$SUM"
wfo() {
  local L="$1" F="$2"; shift 2
  [ -f "$F" ] || return
  step "4. wfo $L"
  run "wfo $L" python3 analysis/wfo_lowmdd_standalone.py --prices "$F" "$@"
  { echo; echo "### $L"; echo '```'; section "4. wfo $L" | tail -25; echo '```'; } >> "$SUM"
}
wfo "hk 今日名單" "$HK_PRICES" --cost-bps 30
wfo "us 今日名單" "$US_PRICES" --cost-bps 10
wfo "hk union ${PERIOD}" "$OUT/universe-hk/prices_union.csv" --cost-bps 30 --windows 63,126,252

if [ -n "$HK_PRICES" ]; then
  echo -e "\n## 5. v2 影子紀錄（dry-run，唔寫檔）" >> "$SUM"
  step "5. sign_v2 dry-run"
  run "sign_v2 dry-run" node scripts/sign_v2.mjs --prices "$HK_PRICES"
fi

echo -e "\n---\n失敗步驟：$FAIL。完整輸出：$LOG" >> "$SUM"
tar -czf "$OUT.tar.gz" -C results "$(basename "$OUT")"
echo
echo "完成。請將 $SUM（或 $OUT.tar.gz）上載返 thread。"
