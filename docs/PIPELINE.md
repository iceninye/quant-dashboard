# 系統全景（產生層 + 分析層）

> 📁 **原始碼已收錄**：本 repo `src/<project>/` 有四個 project 嘅完整 Python 快照（2026-10-17，共 24 檔）。見 [src/README.md](../src/README.md)。

## 兩層架構

```
┌─ 產生層（4 個獨立 Python project，各自 cron 跑）────────────────┐
│  quant-hk   quant-us   sentinel   sentinel-pmfx                 │
│      │          │          │            │                       │
│      └──────────┴──────────┴────────────┘                       │
│                   產出 CSV / HTML / MD（總計 ~800 MB，本機）      │
└──────────────────────────┬──────────────────────────────────────┘
                           │  scripts/sync.mjs（瘦身投影）
┌──────────────────────────▼──────────────────────────────────────┐
│  分析層 ~/quant-dashboard（Node ESM，零依賴）                    │
│  data/*.csv → engine.mjs → docs/index.html → GitHub Pages        │
└─────────────────────────────────────────────────────────────────┘
```

---

## 產生層 — Python 檔案

### quant-hk（1,224 行）
| 檔 | 行數 | 內容 |
|---|---|---|
| `src/core.py` | 834 | 數據抓取（yfinance）、風險指標、Monte Carlo（GBM/Bootstrap/Heston/Jump）、fan chart |
| `src/main.py` | 159 | 主流程：讀 universe → 逐股計算 → 寫 data/charts/reports |
| `src/generate_report.py` | 130 | Markdown/HTML summary 生成 |
| `src/config.py` | 101 | universe、參數、路徑 |

### quant-us（1,142 行）
同 HK 同源：`src/core.py` 769 / `src/main.py` 168 / `src/generate_report.py` 120 / `src/config.py` 85。
分別只喺 universe、benchmark（^GSPC）、時區。

### sentinel（804 行）
| 檔 | 行數 | 內容 |
|---|---|---|
| `src/core.py` | 397 | 風險指標計算（Sharpe/Sortino/Calmar/MDD/Beta/VaR）|
| `src/generate_report.py` | 284 | 風險 dashboard HTML（`templates/`）|
| `src/config.py` | 107 | 持倉同觀察名單 |
| `src/main.py` | 16 | 入口 |

### sentinel-pmfx（1,442 行，**最複雜**）
| 檔 | 行數 | 內容 |
|---|---|---|
| `src/core.py` | **1,420** | 全部功能（見下表）|
| `main.py` | 22 | 入口 |
| `src/__init__.py` | 4 | — |

`src/core.py` 主要函數（行號 = 2026-10-17 版）：

| 行 | 函數 | 作用 |
|---|---|---|
| 49-107 | `AppConfig` / `MarketConfig` / `AlertConfig` / `BrokerConfig` / `UniverseConfig` / `Settings` | dataclass 設定模型 |
| 109 | `load_settings(path="configs/config.yaml")` | 讀 YAML 設定 |
| 173 | `_fetch_goldapi_spot()` | 貴金屬 spot 價格 fallback |
| 187-222 | `_get_twelvedata_key()` / `_download_twelvedata()` | Twelve Data fallback（key 由環境變數讀）|
| 223 | `download_history(ticker, period, interval)` | **主數據入口**；`reset_index(drop=True)` → 出 RangeIndex |
| 249 | `normalize_close(df)` | 「Adj Close / Close」→ Series |
| 276 / 287 | `atr()` / `rsi()` | 技術指標 |
| 298 | `support_resistance(close, window=20)` | 支持 / 阻力 |
| 309 / 323 / 339 / 353 | `trend_following` / `mean_reversion` / `breakout` / `intraday_swing` | **4 個投票策略** |
| 368 / 383 | `monte_carlo_gbm(2,500 paths × 300 steps)` / `percentile_table` | 模擬 → 百分位 |
| 401 | `metrics(close, benchmark)` | **風險指標（Sharpe/vol/MDD/beta/VaR/…）← 修復點 1** |
| 457 | `risk_parity_weights()` | 風險平價權重 |
| 469 / 475 / 484 | `gold_silver_ratio` / `fx_strength_matrix` / `dollar_index_correlation` | 跨資產分析 |
| 496 / 521 / 560 | `cross_asset_summary` / `build_risk_budget` / `compute_portfolio_stats` | 組合層 |
| 539 | `calculate_net_rr_ev(entry, target, stop, action, win_rate, …)` | **成本模型 → net_rr / net_ev** |
| 587-636 | `OrderIntent` / `Broker` / `PaperBroker` / `get_broker` / `send_telegram` / `send_email` | 執行層（paper only）|
| 639 / 649 / 659 / 721 | `classify_ticker` / `format_price` / `build_markdown` / `build_html` | 輸出格式化 |
| 971 | `_multi_vote(signals)` | 4 票 → `action` + `vote_score` |
| 992 | `_build_signal_row(ticker, hist, settings, benchmark, sim_paths, sim_steps, seed)` | **單一標的完整訊號（EV/stop/RR 在此計）← 修復點 2/3** |
| 1138 | `_load_quant_watchlist(output_base, today)` | 由 HK/US quant metrics 抽高 Sharpe 股 |
| 1188 | `run_once(config_path)` | **主流程**（1189 讀 settings、1224 主宇宙、1264 觀察名單、1270 Pending 佔位 ← 修復點 4）|

**run_once 流程**：
```
load_settings → 美元指數 benchmark → for ticker in universe: download → _build_signal_row
             → _load_quant_watchlist → for w in watchlist: download → _build_signal_row
                                     → 數據不足 → Pending 佔位行
             → concat → signals_<date>.csv + buy/hold/sell 分類 + prices + fx matrix + ratio
             → build_markdown + build_html + failures.csv
```

---

## 分析層 — `~/quant-dashboard`（Node 22 ESM，**零 npm 依賴**）

| 檔 | 行數 | 作用 |
|---|---|---|
| `scripts/lib/csv.mjs` | 44 | `parseCsv` / `toCsv`（quote、換行、BOM 全部處理）|
| `scripts/lib/sources.mjs` | 169 | 4 個來源嘅**路徑常數 + 讀取器 + 投影** |
| `scripts/sync.mjs` | 119 | 4 源 → `data/<fam>/<YYYY-MM>.csv`（append-only、跳過已存在日期、體積預算 20 MB）|
| `scripts/engine.mjs` | 354 | **Opportunity Engine**（下詳）|
| `scripts/build.mjs` | 148 | 跑 engine + 生成 `docs/index.html`（單檔、零 CDN、數字 build-time 注入）|
| `scripts/check.mjs` | 67 | 29 項 smoke test |
| `scripts/serve.mjs` | 17 | 本機預覽 `127.0.0.1:8123` |
| `scripts/publish.sh` | 14 | sync → build → check → commit → push |

### `sources.mjs` 讀取器
`dmyToIso` / `isoToDmy` / `monthOf` / `quantDates(which)` / `quantRows` / `quantMeta` / `sentinelDates` / `sentinelRows` / `pmfxDates` / `pmfxRows` / `sentinelMacro` / `listDates`

日期一律**轉 ISO** 先做 key → 避開 `dd-mm-YYYY` 字串排序陷阱。

### `engine.mjs` 函數表
| 行 | 函數 | 作用 |
|---|---|---|
| 24 / 32 | `loadFamily` / `loadAll` | 讀 `data/*.csv` 成記憶體索引 |
| 42 | `buildContext(fam)` | 每個 family 嘅百分位分佈（Sharpe / 動量）|
| 67 / 74 / 81 | `sentiOf` / `pmfxSenti` / `sideOf` | action 文字 → 數值方向 |
| 87 | `quality(row)` | **Quality gate**：Pending / 價格 0 / error / rr_valid / net_rr_valid / 止損 0.3-12% / net_ev>0 |
| 107 | `score(row, ctx)` | PMFX EV 為主 + quant Sharpe 百分位 + 動量 + Sentinel + 多源共識 |
| 140 | `tierOf(row, sc)` | A / B / C / EXCLUDED |
| 151 | `forwardTrack(fam)` | **前向追蹤**：每個訊號之後 1/5/10/20 日實際回報 + target/stop 判定 |
| 201 | `run()` | 主流程，輸出 `dashboard.json` |
| 260 | `buildSeries(fam)` | 每日序列（質量趨勢 sparkline 用）|
| 283 | `audit(fam, track)` | **Gate 階梯 + rank edge + bySide 審計** |

---

## 驗證指令

```bash
cd ~/quant-dashboard
node scripts/check.mjs          # 29 tests（CSV / gate / 方向 / 體積 / HTML）
bash scripts/publish.sh         # 完整一輪 + push
node scripts/serve.mjs          # 本地睇 http://127.0.0.1:8123/
```

```bash
cd ~/hermes-projects/sentinel-pmfx
.venv-pmfx/bin/python -m py_compile src/core.py    # 語法
.venv-pmfx/bin/python verify_fix.py                # 2026-10-17 修復回歸測試（唔寫 report）
```

## 檔案位置通則

| 類型 | 位置 |
|---|---|
| 4 個報告 project | `~/hermes-projects/<name>/` |
| cron 腳本 | `~/.hermes/scripts/`（`schedule` 唔係 cron，係 jobs.json 內嘅 script filename）|
| 本 dashboard | `~/quant-dashboard/`（公開 repo + Pages）|
| 私人數據 vault | `~/fx-vault/` → 私人 repo `iceninye/fx-vault-data` |
| iCloud 報告副本 | `/mnt/c/Users/ice_n/iCloudDrive/Hermes Reports/` |
| 環境變數 / key | `~/.hermes/.env`（**永不入 repo**）|
