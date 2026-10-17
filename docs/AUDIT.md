# 程式碼審計 AUDIT（2026-10-17）

**方法**：直接審本機 `~/quant-dashboard` 實碼（20 個 `.py` + 8 個 `.mjs` + `docs/`），非爬 GitHub 頁面。所有結論附 `檔案:行號` 或實測指令輸出。

**環境實況**（4 個 venv 實測）：

| Project | venv | pandas | numpy | yfinance | scipy |
|---|---|---|---|---|---|
| quant-hk | `.venv-hk` | 3.0.5 | 2.4.6 | 1.5.2 | 1.17.1 |
| quant-us | `.venv-us` | 3.0.5 | 2.4.6 | 1.5.2 | 1.17.1 |
| sentinel-pmfx | `.venv-pmfx` | 3.0.5 | 2.4.6 | 1.5.2 | 1.17.1 |
| sentinel | `.venv` | **3.0.3** | 2.4.6 | **1.4.1** | 1.17.1 |

---

## 1. 環境配置與依賴項

| 檢查項 | 結果 |
|---|---|
| pandas 2.x 已移除 `DataFrame.append()` | ✅ **0 次使用**（`grep` 全部 `.append(` 都係 list append）|
| 其他已移除 API（`applymap` / `fillna(method=` / `iteritems` / `.ix[` / `infer_datetime_format` / `delim_whitespace`）| ✅ **全部 0 次** |
| pandas 3.x runtime deprecation | ✅ import + 實跑 **0 warning** |
| 金鑰依賴（Alpha Vantage / Polygon / Alpaca）| ✅ **完全冇** — 全部用 yfinance 免費源，冇 key 缺失風險 |
| **root `requirements.txt`** | ❌ **唔存在** → `pip install -r requirements.txt` 實測 `ERROR: Could not open requirements file: [Errno 2] No such file` |
| `.env.example` / `pyproject.toml` / `setup.py` | ❌ 全部唔存在 |
| **版本 pin 與實況脫節** | ⚠️ `requirements.txt` 寫 `pandas>=2.0`、`yfinance>=0.2.40`，實際跑 **pandas 3.0.5 / yfinance 1.5.2**；`src/quant-us/requirements.txt` **完全冇版本** |
| **4 個 venv 版本不一致** | ⚠️ `sentinel` = pandas 3.0.3 + yfinance **1.4.1**；其餘 = 3.0.5 + **1.5.2** |

## 2. 資料管道與例外處理

| 檢查項 | 結果 |
|---|---|
| Retry / backoff（tenacity / `@retry` / `max_retries`）| ❌ **完全冇**（grep 0 命中）→ yfinance 429/斷線 = 該標的當日直接失敗 |
| Rate limit 延遲 | ✅ `quant-hk/core.py:232-234` 每 ticker `sleep(uniform(1.5, 3.5))`；`quant-us/core.py:122`、`sentinel-pmfx/core.py:1210` 亦有 |
| 空 DataFrame 處理 | ✅ `quant-us/core.py:127,133` `failed.append(ticker)` + skip，唔會污染下游 |
| **`auto_adjust` 口徑不一致** | ⚠️ `quant-hk:115` = `True`；`sentinel-pmfx:230` = `False`；`sentinel:32` **完全冇設**（靠默認）+ `sentinel:34` 用 `"Adj Close" in columns` 判斷（yfinance ≥0.2.51 `auto_adjust=True` 時根本冇 `Adj Close` → 靜默 fallback `Close`）|
| `ffill` / 缺失值填補 | ✅ `sentinel/core.py:38,122,327` 三處 `ffill()`；`bfill` **冇用**（正確：bfill 會引入 look-ahead）|
| 時區 | ⚠️ 全部 `tz_localize(None)` 轉 naive（`quant-hk/core.py:286`、`generate_report.py:26,31,33`）；HK 收市 16:00 HKT vs US 收市 04:00 HKT 用**同一 `date`** 對齊 → 跨市場 look-ahead 風險，未見 tz-aware 對齊邏輯 |

## 3. 量化模型與計算邏輯

| 檢查項 | 結果 |
|---|---|
| Sharpe 年化因子 | ✅ 正確：`(mean×252 − rf) / (std×√252)` = 年化超額 ÷ 年化波動（`quant-us:285`、`quant-hk:519`、`sentinel:148`）|
| rf 轉日頻 | ✅ Sortino 用 `daily_rf = rf/252`（`quant-us:291`）數學等價 |
| 除以零 / `np.inf` | ✅ 4 種 guard 齊：`if returns.std()==0`（`quant-us:283`）、`if volatility > 0`（`sentinel:148`）、`.replace(0, np.nan)`（`sentinel-pmfx:461,529`）、`+1e-12` epsilon（`quant-us:384`、`quant-hk:519`）|
| 實測 edge cases（pandas 3.0.5 真跑）| ✅ 空 series → `nan`；常數 std=0 → `nan`；單點 → `nan`；**冇一次 `inf` 或 exception** |
| CAGR 年化 | ✅ 用 **365 calendar days**（`quant-us:325,380`、`sentinel:142`）正確 |
| **Sortino 分母** | ⚠️ 用 `downside.std()`（`quant-us:296`）— 標準應該係 downside deviation `sqrt(mean(min(r−MAR,0)²))`，非子集標準差 |
| **最小樣本 guard** | ⚠️ 函數層冇 guard（call-site 有 `len(returns) < 20`、`len(ret) < 30`）；實測 2 個有效觀測仍計出 Sharpe = **−3.86** |
| Black-Scholes / Newton-Raphson IV | **不適用** — repo 冇自行計算 BS/Greeks；`quant-us:410-448` 用 yfinance 提供嘅 `impliedVolatility` + `griddata` 插值 |

## 4. 前端與資料渲染

| 檢查項 | 結果 |
|---|---|
| Streamlit / Dash 狀態重繪、`@st.cache_data` | **不適用** — 完全冇 Streamlit/Dash（grep 0 命中）。架構係 **靜態預生成**：`sync.mjs → engine.mjs → build.mjs → docs/index.html`（零 CDN、單檔）|
| 空資料 fallback | ✅ `build.mjs:15` `fmt()` 對 `null/undefined/NaN` 出 `—`；`build.mjs:134` macro 缺失出「（未抽到 summary.md）」；所有表格 `.map(...).join('')` → 空數組出空字串，**唔會 crash** |
| 自動化測試 | ✅ `node scripts/check.mjs` = **29 通過 / 0 失敗**（含 gate 數一致、冇外部 CDN、含免責聲明）|
| Python 語法 | ✅ **20/20** `py_compile` 通過 |

---

## 你提供嘅除錯指令：實測結果

| 指令 | 實測 | 原因 |
|---|---|---|
| `pip install -r requirements.txt` | ❌ `[Errno 2] No such file` | 呢個 repo 冇 root `requirements.txt`；依賴分散喺 `src/<project>/requirements.txt` 四個檔 |
| `flake8 . --select=E9,F63,F7,F82` | ❌ `No module named flake8` | flake8 未裝 |
| `pytest` | ❌ `No module named pytest` | pytest 未裝，repo 亦冇 Python test 目錄（測試係 `scripts/check.mjs` + `src/*/verify_fix*.py`）|

**替代做法（已執行）**：`py_compile` × 20 + `check.mjs` × 29 + 真跑 edge-case probe（pandas 3.0.5 環境）。

---

## 已確認嘅真問題（按優先級）

| # | 優先 | 問題 | 位置 | 狀態 |
|---|---|---|---|---|
| P1 | 🔴 | `requirements.txt` 與實跑版本脫節 + 4 venv 版本不一致 | `src/*/requirements.txt` | ✅ **已修 2026-10-17** |
| P2 | 🔴 | 冇 root `requirements.txt` / `.env.example` | repo root | ✅ **已修 2026-10-17** |
| P3 | 🔴 | yfinance **冇 retry/backoff** | 4 個 `core.py` 全部 fetch 入口 | ✅ **已修 2026-10-17** |
| P4 | 🟡 | `auto_adjust` 三個 project 三種做法 | 見 §2 | 同一標的不同報告用不同價格口徑，唔可直接比較 |
| P5 | 🟡 | Sortino 分母非標準 downside deviation | `quant-us:296` | Sortino 數值偏差（非 crash）|
| P6 | 🟡 | 量化函數冇最小樣本 guard | `calc_sharpe` / `calc_sortino` | 新 call-site 漏 guard 會出無意義數字 |
| P7 | 🟡 | 跨市場 naive 日期對齊 | `generate_report.py` 各處 | look-ahead 風險（HK vs US 收市時間差 12 小時）|

## 本次已修項目驗證（2026-10-17）

### P1 — 版本 pin 對齊實況

4 個 `requirements.txt` 由 `>=` 無上限（部分甚至完全冇版本）改為 **`>=實測版本, <下個 major`**，並補齊原本漏列嘅依賴（`tenacity`、`openpyxl`、`python-dotenv`）。

**4 個 venv 最終一致性（實測）**：

| Project | pandas | numpy | yfinance | tenacity |
|---|---|---|---|---|
| quant-hk | 3.0.5 | 2.4.6 | 1.5.2 | 9.2.1 |
| quant-us | 3.0.5 | 2.4.6 | 1.5.2 | 9.2.1 |
| sentinel-pmfx | 3.0.5 | 2.4.6 | 1.5.2 | 9.2.1 |
| sentinel | 3.0.5 | 2.4.6 | 1.5.2 | 9.2.1 |

（修復前：sentinel = pandas 3.0.3 + yfinance 1.4.1，其餘 1.5.2）

⚠️ 踩過嘅坑：`uv pip install` **冇 `--upgrade` 時只補「唔滿足」嘅版本** → sentinel 嘅 yfinance 1.4.1 唔滿足 `>=1.5`，uv 直接裝 **1.7.0**（比其他 3 個更新，反而更唔一致）。要精確對齊必須寫 `==` 版本號。

### P2 — root 依賴與環境範例

- `requirements.txt`（新增）：全部 4 個 project 嘅依賴總表，附安裝步驟 + 「核心係 Node.js，唔需要 Python」說明
- `.env.example`（新增）：5 個**全部可選**嘅環境變數，附「缺失時行為」（例：`TWELVEDATA_API_KEY` 缺失 → XAU/USD 印警告後跳過該標的；`TELEGRAM_BOT_TOKEN` 缺失 → Telegram 警報關閉）
- 冇任何必需 API key（全 yfinance 免費源）

### P3 — tenacity retry

4 個 `core.py` 各加一段 `YF_RETRY` 常數 + 包住 fetch 入口：

| Project | 被 retry 包住嘅入口 | 呼叫方式 |
|---|---|---|
| quant-hk | `download_history()`（decorator）| `yf.download` |
| quant-us | 新增 `_fetch_history_retry()` | `yf.Ticker().history()` |
| sentinel | 新增 `_bulk_download_retry()` | `yf.download`（bulk 26 tickers）|
| sentinel-pmfx | 新增 `_yf_download_retry()` | `yf.download` |

參數：`3 次嘗試` / `wait_exponential_jitter(initial=2, max=20)` / `reraise=True`（最後一次失敗照樣 raise，唔改變舊行為）/ 空 result 當失敗以觸發 retry / `before_sleep_log(WARNING)` 記錄每次重試。

**實測（故意令第一次 raise `ConnectionError` 模擬 429）**：

| Project | 結果 |
|---|---|
| quant-hk | ✅ `yf.download` 被呼叫 2 次，回傳 5 行 |
| quant-us | ✅ `Ticker.history` 被呼叫 2 次，回傳 5 行 |
| sentinel-pmfx | ✅ `yf.download` 被呼叫 2 次，回傳 23 行 |
| sentinel | ✅ bulk 真實 fetch `(6, 34)`，降版後連續兩次呼叫正常 |

---

## 建議（未做，等指示）

| # | 建議 | 狀態 |
|---|---|---|
| 1 | 補 root `requirements.txt` + `.env.example` | ✅ 已做（P2）|
| 2 | 版本上限 pin + 統一 4 個 venv | ✅ 已做（P1）|
| 3 | `tenacity` retry 落 4 個 fetch 入口 | ✅ 已做（P3）|
| 4 | 統一 `auto_adjust`（PMFX 因策略需要未調整價，應寫落 config）| ⏳ 未做（P4）|
| 5 | Sortino 改標準 downside deviation | ⏳ 未做（P5）|
| 6 | `MIN_OBS = 20` guard 落 `calc_sharpe` / `calc_sortino` | ⏳ 未做（P6）|
| 7 | 跨市場 tz-aware 對齊 | ⏳ 未做（P7）|
