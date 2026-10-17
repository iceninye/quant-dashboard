# 修復記錄 — Sentinel PMFX `core.py`（2026-10-17）

> 完整 diff：[FIXES-2026-10-17.diff](FIXES-2026-10-17.diff)
> 備份：`~/hermes-projects/sentinel-pmfx/src/core.py.bak-20261017`（**該 project 唔係 git repo**，備份係唯一 rollback 途徑）

## 一句話

PMFX 報告入面 `error` 欄 100% 標的都非空（`'int' object has no attribute 'days'`），令**全部風險指標（Sharpe / 波動 / MDD / Beta / VaR）靜靜地變成缺失**，而後果唔止「少幾欄」——`opportunity_score` 同 `success_rate` 都被系統性扭曲。已修 3 個 root cause（共 5 處改動），並用 4 個標的實測驗證。

---

## Bug 1 — `metrics()` 用 integer index 當日期（主因）

**症狀**：`signals_*.csv` 嘅 `error` 欄每行都有 `'int' object has no attribute 'days'`。

**機制**：
1. `download_history()`（`core.py:223`）最後做 `reset_index(drop=True)`（:217 / :243）→ DataFrame index 變 **RangeIndex（0,1,2,…）**
2. `_build_signal_row()`（:998）原本寫 `close = hist["Close"].astype(float).dropna()` → 個 Series 嘅 index 一樣係 RangeIndex
3. `metrics()`（:406）計 `n_days = (close.index[-1] - close.index[0]).days` → int − int = **int** → int 冇 `.days` → `AttributeError`
4. `metrics()` 嘅 `try/except`（:443-444）吞咗 → `return {"error": str(e)}`
5. `_build_signal_row` 嘅 `if not m:` **唔會攔到**（`{"error":...}` 係 truthy dict）→ 繼續行完，寫出「正常」一行，只係 `error` 欄有字

**實測（修復前，live probe）**：
| 標的 | 抓到的行數 | `metrics()` 回傳 |
|---|---|---|
| 0005.HK | 494 | `{'error': "'int' object has no attribute 'days'"}` |
| JNJ | 502 | 同上 |
| GC=F | 504 | 同上 |

**影響鏈（比 error 欄本身嚴重）**：
| 位置 | 後果 |
|---|---|
| `:1086 **m` 展開入 row | Sharpe / volatility / max_drawdown / calmar / sortino / beta / var_95 / cvar_95 / skew / kurtosis **全部缺失** |
| `:1064 opp += 1.0 if m.get("sharpe", 0) > 1.0` | 永遠 `False` → opportunity_score **永遠少 1 分** |
| `:1065 opp += 1.0 if m.get("max_drawdown", 0) > -0.15` | 缺數據時 default `0` → `0 > -0.15` **恆真 → 永遠錯加 1 分**（邏輯方向反）|
| `:1071 conf_sharpe = 0.05 if m.get("sharpe",0) > 1.0` | 永遠 0 → `success_rate` 永久偏低 0.05 → `ev = s×reward − (1−s)×risk` **系統性低估 EV** |
| `:420-425` beta/alpha | `ret.index.intersection(b_ret.index)` = RangeIndex ∩ DatetimeIndex = **空集** → beta / alpha 永遠 `nan` |

**Fix**：
| 編號 | 位置 | 改動 |
|---|---|---|
| Fix 1 | `_build_signal_row` :998 | `close` 用 `pd.to_datetime(hist["Date"])` 做 index（保留 `Close` 數值語意）|
| Fix 2 | `metrics()` :406 | `isinstance(close.index, pd.DatetimeIndex)` 保護；fallback 用交易日換算日曆日 `(n-1)×365/252` |
| Fix 2b | `normalize_close()` :253 | 幫 benchmark（美元指數）補 DatetimeIndex → beta 嘅 index intersection 終於有交集 |

**驗證（修復後）**：
| 標的 | index 類型 | sharpe | 年化波動 | MDD | error |
|---|---|---|---|---|---|
| 0005.HK | DatetimeIndex | **1.869** | 0.2606 | -0.2211 | False |
| JNJ | DatetimeIndex | **1.217** | 0.1986 | -0.1435 | False |
| GC=F | DatetimeIndex | **1.014** | 0.2439 | -0.2494 | False |
| BTC-USD | DatetimeIndex | **0.269** | 0.3695 | -0.5306 | False |

beta 亦由 `nan` 變實數（GC=F −1.385、0005.HK −0.475、EURUSD=X −0.154）。

---

## Bug 2 — 止損 clamp 壓到貼近 entry → RR 爆表

**症狀**：`GC=F` 止損距離 **0.10%**、`reward_risk` **90.57**、`net_rr` 21.9、`net_ev` 232。`BTC-USD` 同款。

**機制**（`_build_signal_row` :1042-1054 原碼）：
```python
if vote["action"] == "沽":
    stop = min(atr_stop, res_stop)      # 取較近嘅止損
    stop = max(stop, entry * 1.001)     # 但只保證 ≥ entry + 0.1%
```
當阻力位（`resistance`）貼近進場價，`min()` 揀到一個距離只有 0.1% 嘅止損 → `risk ≈ 0.1%×price` → `rr = reward/risk` 數學爆炸。

**衍生矛盾**：原碼有 `rr_valid = 0.5 ≤ rr ≤ 10`（所以 90.57 → `False` ✅），但 `net_rr_valid = net_rr >= 0.5`（:1081）唔理 `rr_valid` → 21.9 → **`True`** → 兩個 validity flag 互相矛盾，任何只睇 `net_rr_valid` 或 `net_ev` 嘅排序都會選中退化訊號。

**Fix**：
| 編號 | 位置 | 改動 |
|---|---|---|
| Fix 3 | :1041-1056 | 加 `min_dist = max(0.5%×entry, 0.5×ATR)`；沽：`max(stop, entry×1.001, entry+min_dist)`；買：`min(stop, entry×0.999, entry−min_dist)` 再夾 `≥ entry×0.01` |
| Fix 5 | :1088 | `net_rr_valid = bool(rr_valid and pd.notna(net_rr) and net_rr >= 0.5)` |

**驗證（修復後）**：
| 標的 | 止損距離 | rr | rr_valid | net_rr | net_rr_valid |
|---|---|---|---|---|---|
| GC=F | 0.10% → **0.82%** | 90.57 → **10.34** | False（>10 上界）| 7.30 | **False**（一致 ✅）|
| BTC-USD | 0.10% → **1.14%** | → 10.90 | False | 8.42 | **False** |
| EURUSD=X | **0.99%** | **2.55** | **True** | 1.73 | **True** |

→ `EURUSD=X` 成為修復後第一個「兩個 validity flag 都過」嘅訊號。

---

## Bug 3 — 「Pending」佔位行被標成有效訊號

**症狀**：2026-10-17 報告 34 行 = 24 行正常 + **10 行全 0**（`close=0 / entry=0 / action=Pending`），而且 `rr_valid` = **True**。同時 `source` / `quant_sharpe` 兩欄**整欄消失**（schema 漂移）。

**機制**：`run_once()` 嘅動態觀察名單（`:1264`，來自 HK/US quant 嘅高 Sharpe 股）如果 `len(hist) < min_history(120)`，會 append 佔位 row：
```python
{'ticker': pt, ..., 'action': 'Pending', 'entry_price': 0, 'rr_valid': True}
```
- `0 / 0` 唔係「有效」，但標 `True` → 下游容易當真訊號
- 佔位 row 冇 `source` / `quant_sharpe` key → 當日全部觀察名單都 Pending → 兩欄冇任何行填過 → **pandas 直接唔輸出該欄** = schema 漂移

**當時真相**：觀察名單嗰 10 隻（0005.HK / 1347.HK / JNJ / MU …）事後用同一段 code 抓得到 **494-504 行**數據（遠超 120 上限）→ 即係 run 當時係 **yfinance 暫時性失敗/限流**，唔係 ticker 問題。

**Fix**：
| 編號 | 位置 | 改動 |
|---|---|---|
| Fix 4b | :1290-1301 | `'rr_valid': False` + 補 `'source'` / `'quant_sharpe'`（保持 schema）+ `'error': 'insufficient_history'` |
| Fix 4a | :1071 | `m.get("max_drawdown", -1.0)` — 缺數據唔再無條件加分 |

---

## 修復前後對照（同日、同參數 400 paths × 120 steps）

| 標的 | 修復前 | 修復後 |
|---|---|---|
| 0005.HK | `error` 非空、sharpe 缺、beta nan | sharpe 1.869、mdd -0.2211、beta -0.475 |
| GC=F | 止損 0.10%、rr 90.57、net_rrv True（矛盾）| 止損 0.82%、rr 10.34、net_rrv False（一致）|
| BTC-USD | 止損 0.10%、net_ev 6144 | 止損 1.14%、net_ev 6144（still flagged invalid：rr>10）|
| EURUSD=X | — | 止損 0.99%、rr 2.55、rr_valid True、net_ev 0.01 |

---

## 未修 / 殘留風險（誠實列出）

1. **`rr > 10` 就一定標 invalid**：修復後強趨勢標的（GC=F 10.34）仍會被拒。呢個係原設計取態（上界 10），**未改**，因為要動就要討論「遠目標係唔係真訊號」。目前決定：保持保守。
2. **yfinance 限流冇 retry**：Bug 3 嘅觸發條件（抓唔到數據）冇加 retry / backoff，只係修好「抓唔到時唔會污染數據」。要加 retry 屬新功能，等指示。
3. **`net_ev` 單位係價位而唔係 R**：`EURUSD=X` net_ev 0.01（1.14 → 1.13 級數）同 `BTC-USD` net_ev 6144 唔可以一齊排。跨資產比較應該用 `net_rr` 或 R-multiple。目前 dashboard 用 `net_rr` 做 gate，但排序仍顯示 net_ev → **未統一**。
4. **`opportunity_score` 係舊值不可比**：修復會令…（下一行）分數改變（Sharpe 加分終於會發生、MDD 加分唔再誤加）→ 歷史 CSV 同新 CSV 嘅 `opportunity_score` **唔可以直接比較**。
5. **`raw/raw_XAUUSD_X_*.csv` 欄位同其他 raw 檔唔一致**（`open,high,low,close` 全部小寫 + 大寫並存）→ 讀取時要 case-insensitive。

---

## Rollback

```bash
cd ~/hermes-projects/sentinel-pmfx
cp src/core.py.bak-20261017 src/core.py      # 還原
.venv-pmfx/bin/python -m py_compile src/core.py
```

## 重跑驗證

```bash
cd ~/hermes-projects/sentinel-pmfx
.venv-pmfx/bin/python verify_fix.py     # 只讀，唔寫任何 report / CSV
```
預期：4 個標的 `error=False`、sharpe 有值；GC=F 止損距離 ≥ 0.8%；`net_rr_valid` 只喺 `rr_valid=True` 時為 True。

## 未執行（需另外批准）

- **完整重跑 PMFX**（`main.py`）：會寫入 `reports/<今日>/` 並覆蓋當日報告。等指示。
- 觀察名單 retry / backoff。
- `net_ev` → 統一改成 R-multiple。
