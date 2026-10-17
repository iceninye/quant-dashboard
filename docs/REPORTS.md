# 四份量化報告 — 完整結構

> 呢份係本機環境（WSL `wsluser`）嘅實況記錄，2026-10-17 由程式同實檔逐項核對過。
> 所有路徑都係絕對路徑，方便直接 trace。冇任何 API key / token 在內。

## 總覽

| # | 報告 | Cron（HKT） | 入口 | 計算耗時 | 發送 |
|---|---|---|---|---|---|
| 1 | **HK Quant** | `0 18 * * 1-5`（Mon-Fri 18:00）| `hk_quant_compute.sh` | 長（20 分鐘＋）| WhatsApp 18:20（`hk_quant_notify.sh`）|
| 2 | **US Quant** | `45 7 * * 2-6`（Tue-Sat 07:45）| `us_quant_compute.sh` | 長 | WhatsApp 08:05（`us_quant_notify.sh`）|
| 3 | **Sentinel PMFX** | `15 7 * * 1-5` + `15 19 * * 1-5` | `pmfx_compute.sh` | 中（~2-4 分鐘）| local（寫檔）|
| 4 | **Hermes Sentinel** | `15 8 * * 2,5`（Tue/Fri 08:15）| `sentinel_daily_send.sh` | 短 | local（寫檔）|

（cron 定義：`~/.hermes/cron/jobs.json`；`schedule.expr` 係標準 cron expression）

四個報告**全部獨立**：冇互相 import，冇共用 library。唯一交集係 PMFX 會讀 quant 嘅 `output/data/metrics_*.csv` 做「動態觀察名單」（`_load_quant_watchlist`）。

---

## 1. HK Quant

**路徑**：`~/hermes-projects/quant-hk/`　**Python**：1,224 行（`src/core.py` 834 / `src/main.py` 159 / `src/generate_report.py` 130 / `src/config.py` 101）

**做乜**：香港 Top 100 市值股票，計風險指標 + Monte Carlo（GBM / Bootstrap / Heston / Jump）+ 生成 fan chart。

**輸出結構**（80 個交易日各一套）：
```
output/
├── data/
│   ├── metrics_<dd-mm-YYYY>.csv       # 每股票風險指標（98-100 行）
│   ├── prices_<dd-mm-YYYY>.csv        # 歷史價
│   ├── returns_<dd-mm-YYYY>.csv       # 日回報
│   ├── correlation_<dd-mm-YYYY>.csv   # 相關矩陣
│   └── rolling_corr_<dd-mm-YYYY>.csv  # 滾動相關（48,000+ 行，最大檔）
├── charts/                            # fan_<ticker>.png、vol_surface 等（44 個）
└── reports/                           # summary_<date>.md（84 個）
```

**`metrics_*.csv` 欄位字典**（19 欄）：
`ticker, last_price, daily_return, week_return, month_return, cagr, volatility, sharpe, sortino, max_drawdown, max_dd_duration, calmar, beta, var_95, parametric_var_95, cvar_95, skewness, kurtosis, avg_volume`

範例（`metrics_31-08-2026.csv` 第 1 行）：`2388.HK, 52.70, 0.0343, 0.0467, 0.0067, 0.5725, 0.2286, 1.9504, 3.0000, -0.1112, 62, 4.4309, 0.4014, -0.0185, -0.0217, -0.0288, 0.2244, 3.9744, 10136884.65`

**注意**：
- ⚠️ `beta` 有部分行係空（`parametric_var_95` 之後有 `,,`）—— 港股 benchmark 對唔上時會 nan。
- ⚠️ `rolling_corr_*.csv` 每個 ~5.9 MB，80 個 = 475 MB。**無自動 prune**（冰 2026-10-17 明示暫時唔加 cron），係本機最大單一數據源。
- ⚠️ 檔名日期係 `dd-mm-YYYY` 字串 → **唔可以用字串排序攞最新**（`31-08` 會排喺 `16-10` 之後）。

---

## 2. US Quant

**路徑**：`~/hermes-projects/quant-us/`　**Python**：1,142 行（`src/core.py` 769 / `src/main.py` 168 / `src/generate_report.py` 120 / `src/config.py` 85）

結構同 HK 完全一致（同源 codebase，分開 fork）：
```
output/data/{metrics,prices,returns,correlation,rolling_corr}_<dd-mm-YYYY>.csv
output/charts/   （vol_surface_AAPL.png 等，42 個）
output/reports/  （summary_*.md，84 個）
```

`metrics_*.csv` 欄位同 HK **一模一樣**（19 欄）。

**分別**：美股 universe（大型科技 + 半導體 + 金融，~99 隻）、`beta` 用 ^GSPC、有開盤時差（07:45 HKT = 美股收市後）。
`beta` 亦有空值（例：`WDC` 行 `var_95` 係空）。

---

## 3. Sentinel PMFX

**路徑**：`~/hermes-projects/sentinel-pmfx/`　**Python**：1,442 行（`src/core.py` **1,420** + `main.py` 22）

**做乜**：26 個 config 標的（金銀 / FX 主要 / FX 交叉 / 商品 / 港股 / 美股 / BTC）+ 動態觀察名單（從 HK/US quant 抽高 Sharpe 股），每個標的：
- 4 個策略獨立投票：`trend_following` / `mean_reversion` / `breakout` / `intraday_swing`
- `_multi_vote` 匯總 → `action`（買/沽/持有/觀望）
- Monte Carlo GBM（2,500 paths × 300 steps）→ 百分位表 → `success_rate`
- ATR14 止損 + 支持/阻力目標 → `reward_risk`
- 成本模型（`calculate_net_rr_ev`）→ `net_rr` / `net_ev`

**輸出結構**（每個 run 一個日期資料夾）：
```
reports/<dd-mm-YYYY>/
├── raw/raw_<ticker>_<date>.csv          # 原始價（Date,Adj Close,Close,High,Low,Open,Volume）
├── data/
│   ├── signals_<date>.csv               # 全部標的（34-36 行）★ 主檔
│   ├── buy_list_<date>.csv / hold_list_<date>.csv / sell_list_<date>.csv   # 按 action 分類
│   ├── prices_<date>.csv                # 12,000+ 行 long format（Date,Close,ticker）
│   ├── fx_strength_matrix_<date>.csv    # 24×24 交叉強弱
│   ├── gold_silver_ratio_<date>.csv     # 356 行
│   ├── dxy_correlation_<date>.csv
│   └── failures_<date>.csv              # 抓唔到數據嘅 ticker + 原因
└── reports/{dashboard,summary}_<date>.{html,md}
```

**`signals_*.csv` 欄位字典（38 欄）**：
```
ticker, name, error,
trend_signal, trend_reason, mean_signal, mean_reason,
break_signal, break_reason, swing_signal, swing_reason,
action, vote_score, vote_count, opportunity_score,
entry_price, target_price, stop_loss,
success_rate, reward_risk, rr_valid, expected_value,
net_rr, net_ev, net_rr_valid,
last_price, support, resistance, atr14, rsi14,
p10_20d, p25_20d, p50_20d, p75_20d, p90_20d, rank
```

**關鍵欄位語意**：
| 欄 | 意思 |
|---|---|
| `error` | 引擎異常訊息；非空 = 該行數值不可信（2026-10-17 前 100% 標的都中，見 [FIXES.md](FIXES.md)）|
| `action` | `買` / `沽` / `持有` / `觀望` / **`Pending`**（觀察名單數據不足嘅佔位行）|
| `opportunity_score` | 0-10，由 vote + 風險指標加成組成 |
| `entry_price` / `target_price` / `stop_loss` | 進出場價（`觀望` 時 target = entry）|
| `success_rate` | Monte Carlo 路徑達標比例 |
| `reward_risk` | 毛利比（未計成本）；`rr_valid = 0.5 ≤ rr ≤ 10` |
| `net_rr` / `net_ev` | 扣成本後；`net_rr_valid` 要同 `rr_valid` 一致（2026-10-17 修）|
| `atr14` / `rsi14` / `support` / `resistance` | 技術指標 |
| `p10_20d`…`p90_20d` | 20 日模擬百分位 |
| `rank` | 當日 opportunity_score 排名 |

**數據來源**：yfinance（主）→ Twelve Data（fallback，需 key）→ gold-api.com（貴金屬 spot）。`configs/config.yaml` 有 `history_period: 2y`、`interval: 1d`、`min_history: 120`。

**⚠️ schema 會漂移**：2026-10-17 起 `source` / `quant_sharpe` 兩欄消失（因為當日觀察名單全部 Pending，冇任何行寫入該欄）→ 下游一定要當 optional。

---

## 4. Hermes Sentinel

**路徑**：`~/hermes-projects/sentinel/`　**Python**：804 行（`src/core.py` 397 / `src/generate_report.py` 284 / `src/config.py` 107 / `src/main.py` 16）

**做乜**：港股 + 美股持倉／觀察股嘅**風險角度**監控（唔係進出場訊號）：CAGR、波動、Sharpe、Sortino、Calmar、MDD、Beta、VaR/CVaR → 風險等級 + 建議動作。

**輸出**：
```
reports/<dd-mm-YYYY>/
├── signals_<dd-mm-YYYY>.csv    # 29 行
├── dashboard_<dd-mm-YYYY>.html # 44 KB
└── summary_<dd-mm-YYYY>.md
```

**`signals_*.csv` 欄位（20 欄）**：
`ticker, name, sector, market, cagr, volatility, sharpe, sortino, calmar, max_drawdown, daily_return, week_return, month_return, beta, var_95, cvar_95, risk_level, risk_label, risk_level_text, action`

**注意**：`action` 係風險動作（減持／持有／加倉），**冇 entry / target / stop** → 唔可以直接做交易機會，只可以做過濾／加成。

---

## 交叉分析嘅現實限制

1. **只有 PMFX 有進出場價** → 「獲利機會」排序只能建基於 PMFX；其他三份報告只能做**加成 / 否決**。
2. **報告頻率唔同** → Sentinel 只 Tue/Fri，所以週三、週四嘅 PMFX 訊號冇 Sentinel 覆蓋（本 dashboard 會顯示覆蓋率）。
3. **量化指標定義有差異** → HK/US quant 同 PMFX 各自計 Sharpe/MDD，同樣叫 `sharpe` 但窗口唔同（quant: 完整歷史；PMFX: `history_period` = 2y）→ 唔可以當同一把尺。
4. **冇任何一份報告做過交易驗證** → 所有數字係模型輸出。證明「機會」真定假要靠本 dashboard 嘅前向追蹤。
