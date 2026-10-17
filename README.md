# quant-dashboard

由 4 份每日量化報告交叉分析嘅 dashboard（GitHub Pages 靜態站）。

**Live**: https://iceninye.github.io/quant-dashboard/

## 4 個來源

| 報告 | 內容 | 路徑 |
|---|---|---|
| HK Quant | Top 100 港股 Monte Carlo | `~/hermes-projects/quant-hk/output/data/metrics_<dd-mm-YYYY>.csv` |
| US Quant | 美股同款 | `~/hermes-projects/quant-us/output/data/metrics_<dd-mm-YYYY>.csv` |
| Sentinel | 港股/美股風險監控 | `~/hermes-projects/sentinel/reports/<dd-mm-YYYY>/signals_*.csv` |
| Sentinel PMFX | 多資產 26-36 標的 MC + 4 策略投票 | `~/hermes-projects/sentinel-pmfx/reports/<dd-mm-YYYY>/data/signals_*.csv` |

只取「瘦身投影」（每標的十幾欄），**唔會 copy 原始 report / xlsx / PNG**（避免 repo 爆）。

## 核心方法

1. **因子驗證**（`scripts/factors.mjs`）：用 HK / US quant 同 Sentinel 歷史數據，測 6 個訊號（低 MDD、低波動、Sharpe、月動量、週反轉、Sentinel 建議）。t+1 入場、持有 5 / 20 日、扣成本，頭 20% 對當日等權；前半 / 後半樣本都正 + 非重疊 t ≥ 2 先算「通過」，t 1.5–2 算「觀察」。
2. **PMFX 前向追蹤**（`scripts/engine.mjs`）：限價 entry 要被收市價觸及先算成交，回報由成交後計、扣成本。價格優先用 HK / US quant 收市（PMFX 約 4% 行 close 慢咗一行）。
3. **Quality gate**：`rr_valid` + `net_rr_valid` + 止損距離 0.3%–12% + `net_ev > 0` + `error` 欄為空。
4. **數據核對**（`dataAudit`）：每次 build 重算缺口、重複行、全空欄位、PMFX 同 quant 收市價差異、PMFX error 行，結果放 dashboard §5。

Dashboard 次序：今日結論 → 名單（只列通過 / 觀察級因子）→ 因子驗證 → PMFX 訊號（未驗證）→ PMFX 追蹤 → 數據核對 → 宏觀。

## 用法

```bash
node scripts/sync.mjs --days=120   # 4 報告 → data/*.csv（append-only，跳過已存在日期）
node scripts/build.mjs             # engine + docs/index.html
node scripts/build.mjs             # （build 會自動先跑 engine）
node scripts/check.mjs             # smoke test（32 項）
```

## 目錄

```
data/{hk,us,sentinel,pmfx,macro}/<YYYY-MM>.csv   # 按月分片，append-only
docs/index.html                                  # 生成嘅 dashboard（單檔、零 CDN）
docs/data/dashboard.json                         # 完整引擎輸出（供程式用）
scripts/{sync,engine,factors,build,check}.mjs + lib/{csv,sources}.mjs
```

## 文件

| 檔案 | 內容 |
|---|---|
| [docs/REPORTS.md](docs/REPORTS.md) | **四份報告完整結構**：cron、目錄樹、每個 CSV 嘅欄位字典、已知問題 |
| [docs/PIPELINE.md](docs/PIPELINE.md) | 系統全景：產生層 4 個 Python project + 分析層 JS，每隻函數嘅行號同作用 |
| [docs/FIXES.md](docs/FIXES.md) | 2026-10-17 Sentinel PMFX 修復記錄：3 個 root cause、5 處改動、前後實測數字、rollback |
| [docs/WFO.md](docs/WFO.md) | 港股低 MDD walk-forward 驗證結果、方法同局限（數字來自本機運行） |
| [docs/APP.md](docs/APP.md) | 本 dashboard 嘅運作流程同設計取態 |
| [docs/DATA-COVERAGE.md](docs/DATA-COVERAGE.md) | 每個 family 嘅日期覆蓋、缺口原因、已知污染期間 |
| [src/](https://github.com/iceninye/quant-dashboard/tree/main/src) | **四份報告嘅 Python 原始碼快照**（2026-10-17，24 檔，已過安全掃描）|

## 免責

所有數字係模型輸出（Monte Carlo / 策略投票 / 統計指標），**未經交易驗證**，唔構成投資建議。
