# 數據覆蓋範圍同缺口（2026-10-17）

本 repo 收錄 `data/<family>/*.csv`（按月分片，瘦身後結構化數據）。全部 family 由 **2026-06-18** 開始。

| Family | 日數 | 首日 | 末日 | 節奏 | 來源 |
|---|---|---|---|---|---|
| `hk`（港股量化）| 63 | 2026-06-18 | 2026-10-16 | 逢交易日 18:00 | `~/hermes-projects/quant-hk/output/<date>/` |
| `us`（美股量化）| 62 | 2026-06-18 | 2026-10-17 | 逢交易日 07:45 | `~/hermes-projects/quant-us/output/<date>/` |
| `sentinel`（港股+美股風險）| 28 | 2026-06-18 | 2026-10-16 | **週二、週五** 08:15 | `~/hermes-projects/sentinel/reports/<dd-mm-YYYY>/` |
| `pmfx`（多資產信號）| 65 | 2026-06-18 | 2026-10-17 | 逢交易日 07:15 + 19:15 | `~/hermes-projects/sentinel-pmfx/reports/<dd-mm-YYYY>/` |
| `macro`（VIX/DXY/10Y/銅金比/F&G）| 28 | 2026-06-18 | 2026-10-16 | 跟 `sentinel` | Sentinel 報告內嘅 macro 區塊 |

## 缺口係「正常」嘅情況

| 現象 | 原因 |
|---|---|
| `sentinel` / `macro` 只有 28 日（其他 62-65）| Sentinel 報告只逢**週二、週五**跑 |
| 週末冇任何 family 有新數據 | 報告本身唔跑 |
| `hk` 末日 10-16、`us` 末日 10-17 | HK 18:00 跑（收市後同日）；US 07:45 跑（美股前一晚收市）→ 天然相差一日 |
| `pmfx` 一日可能兩次（07:15 / 19:15）| `sync.mjs` 一日一行，取最新一次（19:15 覆蓋 07:15）|

## ⚠️ 歷史樣本嘅已知污染

| 期間 | 問題 |
|---|---|
| **2026-10-17 之前所有 PMFX 行** | 上游 `metrics()` bug：`error` 欄全部非空、`sharpe`/`vol`/`mdd`/`beta` 全缺、止損距離退化到 0.10% → 呢批行嘅 `rr_valid` / `net_rr_valid` / `net_ev` 唔可信 |
| 2026-10-17 起 | 已修復（見 `docs/FIXES.md`）；17-10 用 `sync.mjs --refresh=2026-10-17` 重寫過 |

**推論**：Gate 階梯／排名有效性（`audit`）嘅歷史統計含大量壞樣本 → 現階段唔可以用嚟判斷 gate 有冇用。要等新數據累積 ≥20 個交易日再重算。

## 更新方式

```bash
node scripts/sync.mjs                      # 只加新日期（append-only，最快）
node scripts/sync.mjs --days=180           # 擴大窗口
node scripts/sync.mjs --refresh=2026-10-17 # 上游修好後重寫指定日
node scripts/sync.mjs --refresh            # 重寫窗口內所有日期
```
