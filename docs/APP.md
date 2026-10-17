# quant-dashboard 運作文件

## 一句話

由 4 份每日報告抽取瘦身投影，用 **Opportunity Engine** 交叉篩選，再用**前向追蹤**驗證 —— 目的唔係「搵到一定贏嘅機會」，而係**分清楚邊啲機會可信、邊啲係模型假象**。

## 流程

```
4 個來源（HK/US quant, Sentinel, PMFX）
        │  scripts/sync.mjs   ← 只抽十幾欄、按月分片、append-only、跳過已存在日期
        ▼
   data/{hk,us,sentinel,pmfx,macro}/<YYYY-MM>.csv     （全 repo 1.53 MB / 120 日）
        │  scripts/engine.mjs
        │   1. quality gate（rr_valid + net_rr_valid + 止損 0.3-12% + net_ev>0 + error 為空）
        │   2. 跨報告加成（Sharpe 百分位、月動量、Sentinel 方向/風險）
        │   3. 前向追蹤（1/5/10/20 日實際回報，target/stop 判定）
        │   4. gate 階梯審計（每層 filter 之後勝率升定跌）
        ▼
   docs/data/dashboard.json  →  docs/index.html（單檔、零 CDN）
        │
        ▼  scripts/publish.sh → git push → GitHub Pages
   https://iceninye.github.io/quant-dashboard/
```

## 重要設計決定

| 決定 | 原因 |
|---|---|
| 機會來源**只** PMFX | 4 份報告中只有佢有 `entry/target/stop/expected_value`；其他報告冇進出場價，唔可以無中生有 |
| 一定要有 quality gate | PMFX 有 13/34 個標的止損距離 < 0.3%（例：BTC-USD 0.10%）→ RR 會爆到 132，net_ev 假高 |
| 一定要有前向追蹤 | 冇實際回報數字，就冇辦法知「EV 排序」係唔係真 |
| Gate 階梯審計 | 分開「filter 有用」同「filter 只係過度擬合」 |
| 只 push 瘦身數據 | 原始 report / xlsx / PNG 唔入 repo（防爆倉） |

## 指標定義（避免誤讀）

| 欄／欄名 | 實際意思 |
|---|---|
| `avgR5` / `avgR20`（Gate 階梯、rank edge）| **方向調整後嘅百分比回報**：做多 `(price−entry)/entry`、做空反號；5 / 20 個交易日。**唔係 R-multiple** |
| `winRate` | 已結算訊號中「先觸及目標」嘅比例（20 個交易日內；先觸及止損算輸）|
| `net_ev` | **單位係標的價位**，唔可以跨資產比較（FX 0.01 vs BTC 6604）→ 跨資產要用 `net_rr` |
| `stopPct` | 止損距離**絕對值**（做空嘅 stop 高於 entry，冇取絕對值會變負數）|
| `opp` | PMFX `opportunity_score`（0-10）|
| `score` | 本 dashboard 加權分（唔可以同 `opp` 直接比）|

## 已知數據問題（要留意）

1. **PMFX `error` 欄**：2026-10-16 嘅 run 36/36 行都有 `'int' object has no attribute 'days'`；10-17 有 24/34。代表引擎逐個標的都 throw，數值可信度成疑。
2. **PMFX schema 漂移**：10-17 起 `source` / `quant_sharpe` 兩欄消失 → dashboard 已當 optional 處理，但跨報告連結會變弱。
3. **Sentinel 唔係每日**：只喺 Tue/Fri（`08:15 * * 2,5`），所以 Sentinel 風險覆蓋會有 2-3 日延遲。
4. **`rr_valid=false` 嘅 EV 係垃圾**：排序時必須先過 gate，唔可以純粹按 net_ev 排。

## 用法

```bash
bash scripts/publish.sh          # 同步 + 重建 + 檢查 + push（一條指令）
node scripts/sync.mjs --days=30  # 只同步最近 30 日
node scripts/check.mjs           # 29 個 smoke test
node scripts/serve.mjs           # 本地預覽 http://127.0.0.1:8123/
```

## 免責

所有數字係模型輸出，未經交易驗證，唔構成投資建議。
