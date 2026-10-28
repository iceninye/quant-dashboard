# 數據缺口：逐項判斷同補回步驟（2026-10-28）

原則：只還原上游當日真實產出嘅原檔，唔插補、唔用未來數據重算。補唔到就明確標「已知限制」。

| # | 項目 | 判斷 | 處理 |
|---|---|---|---|
| 1 | Sentinel 07-10→07-31、09-01→09-09 | 未證實。上游機器停咗嘅話冇原檔 | 跑 `gap_sources.mjs` 搜本機；搵唔到先入 `known_gaps.csv` |
| 2 | Macro 同日缺口 | 同 Sentinel（macro 抽自 `summary.md`） | 同上，一齊處理 |
| 3 | PMFX 07-16→07-31 | 補唔補都冇用：全段喺 error 時期，gate 一律排除 | 自動標「已知限制」 |
| 4 | PMFX 2304/2628 行 error | 補唔到，亦唔應該重判：風險欄缺失（1664 行冇 sharpe）、止損距離失真 | 標「已知限制」；放寬測試見下 |
| 5 | US 07-15 空 close（94 行，舊 backfill 補咗 7 行，餘 87） | 可修：repo close 係未復權價，報告日 D = 交易日 D−1，修對齊後 94/94 有價 | 本機下載 + `backfill_prices.mjs --rebuild`（自動偵測對齊） |
|   | US 07-17→07-30、Sentinel 09-04→09-08 | 完全冇 row，補價工具幫唔到 | 只能搵原檔，否則 known_gaps |

放寬 gate 嘅敏感度（引擎即時計）：error 行但通過其餘規則嘅 1147 個訊號，成交 489，5 日平均 −1.19%，124/472 為正 → 冇 edge，gate 唔算過嚴，唔放寬。

## 本機指令（用 sentinel/.venv 嘅 python，要有 yfinance）

```bash
cd ~/quant-dashboard && git checkout main && git pull

# A. US 87 個空 close（只讀＋寫 results/，唔改 data/）
~/hermes-projects/sentinel/.venv/bin/python3 analysis/download_raw_closes.py --market us
node scripts/backfill_prices.mjs --prices results/raw_closes_us_*.csv --rebuild          # dry-run：會印 lag（US 應該係 1）同通過／拒絕數
node scripts/backfill_prices.mjs --prices results/raw_closes_us_*.csv --rebuild --apply  # 只替換同 ticker 嘅舊行（舊對齊產出，07-15 嗰 7 行偏差最多 0.5%）
# HK 嘅舊行用 HK prices 檔同一方式重算（lag 應該係 0）：... --prices <prices_hk 或 raw_closes_hk> --rebuild

# B. 搜原檔（只讀，唔會改任何檔）
node scripts/gap_sources.mjs --root "<Obsidian 路徑>" --fam hk,us,sentinel
cat results/gap-sources-*/found.tsv
bash results/gap-sources-*/restore_plan.sh      # 睇清楚先跑；cp -n -p，零覆蓋
node scripts/sync.mjs --days=150 && node scripts/build.mjs && node scripts/check.mjs

# C. 搵唔到嘅缺口：把 B 印出嘅 fam,from,to,reason 行加入 data/known_gaps.csv
```
改完 `bash scripts/publish.sh`。HK/US 07-16→07-31 缺口已有 backfill 覆蓋，唔屬此範圍。
