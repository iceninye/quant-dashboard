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

1. **機會來源只有 PMFX** — 4 份報告中只有佢提供 `entry / target / stop / expected_value / net_ev`。
2. **Quality gate**（`scripts/engine.mjs`）：`rr_valid` + `net_rr_valid` + 止損距離 0.3%–12% + `net_ev > 0` + `error` 欄為空。
3. **跨報告加成**：quant Sharpe 百分位、月動量、Sentinel 風險／方向 → 加減共識分。
4. **前向追蹤**：每個訊號用之後實際價格計 1/5/20 日回報，睇有冇觸及目標或止損 —— 呢個係唯一可以證明「機會」真定假嘅方法。
5. **Gate 階梯審計**：每加一層 filter，睇勝率／平均回報係升定跌（跌 = gate 揀錯）。

## 用法

```bash
node scripts/sync.mjs --days=120   # 4 報告 → data/*.csv（append-only，跳過已存在日期）
node scripts/build.mjs             # engine + docs/index.html
node scripts/build.mjs             # （build 會自動先跑 engine）
node scripts/check.mjs             # smoke test
```

## 目錄

```
data/{hk,us,sentinel,pmfx,macro}/<YYYY-MM>.csv   # 按月分片，append-only
docs/index.html                                  # 生成嘅 dashboard（單檔、零 CDN）
docs/data/dashboard.json                         # 完整引擎輸出（供程式用）
scripts/{sync,engine,build,check}.mjs + lib/{csv,sources}.mjs
```

## 文件

| 檔案 | 內容 |
|---|---|
| [docs/REPORTS.md](docs/REPORTS.md) | **四份報告完整結構**：cron、目錄樹、每個 CSV 嘅欄位字典、已知問題 |
| [docs/PIPELINE.md](docs/PIPELINE.md) | 系統全景：產生層 4 個 Python project + 分析層 JS，每隻函數嘅行號同作用 |
| [docs/FIXES.md](docs/FIXES.md) | 2026-10-17 Sentinel PMFX 修復記錄：3 個 root cause、5 處改動、前後實測數字、rollback |
| [docs/APP.md](docs/APP.md) | 本 dashboard 嘅運作流程同設計取態 |
| [src/](https://github.com/iceninye/quant-dashboard/tree/main/src) | **四份報告嘅 Python 原始碼快照**（2026-10-17，24 檔，已過安全掃描）|

## 免責

所有數字係模型輸出（Monte Carlo / 策略投票 / 統計指標），**未經交易驗證**，唔構成投資建議。
