#!/usr/bin/env python3
"""低回撤（low-MDD）因子 walk-forward 驗證 — 獨立版（只需 pandas + numpy）

做法抽自 hermes-unified/src/backtest.py：
  - t 日收市計訊號，t+1 日收市入場（防 look-ahead）
  - 扣來回成本（按換倉量計）
  - 同當日全 universe 等權比，睇超額報酬
  - t 值按「一個持有期」做時間區塊 cluster（同期唔同股票高度相關），另附 Newey-West
  - 參數（回望窗口 W）只用「已完結」嘅持有期揀，之後先套用落 OOS fold
  - 最後講明要幾多個持有期先夠 |t| = 2（power）

用法：
  python3 wfo_lowmdd_standalone.py --prices path/to/prices_16-10-2026.csv
  python3 wfo_lowmdd_standalone.py --prices <csv> --cost-bps 30 --top 10 --rebalance 21
  python3 wfo_lowmdd_standalone.py --selftest        # 合成數據自測（唔需要任何檔）

prices CSV 格式：第一欄日期，其餘每欄一隻股票嘅收市價（即 quant-us / quant-hk 嘅 prices_<日>.csv）。

⚠️ 已知局限（結果出嚟要一併睇）：
  1. Universe 係 run 當日嘅「最活躍 / Top N」名單，過去 2 年跌出榜嘅股票唔喺度
     → 有倖存者偏差，會令低回撤睇落好啲。呢個 script 無辦法修正。
  2. 2 年數據只有約 20 個月度持有期，統計力有限，見輸出最後嘅 power 計算。
  3. 用咗收市價成交，冇計滑價、停牌、成交額限制。
"""
from __future__ import annotations

import argparse
import math
import sys

import numpy as np
import pandas as pd
from numpy.lib.stride_tricks import sliding_window_view

TRADING_DAYS = 252


# ---------- 數據 ----------
def load_prices(path: str, max_nan: float = 0.2) -> pd.DataFrame:
    df = pd.read_csv(path, index_col=0, parse_dates=True)
    df = df.sort_index()
    df = df[~df.index.duplicated(keep="last")]
    df = df.apply(pd.to_numeric, errors="coerce")
    df = df.loc[:, df.isna().mean() <= max_nan]
    df = df.ffill(limit=3)
    return df.where(df > 0)


# ---------- 訊號：trailing W 日最大回撤（只用 t 及之前嘅數據）----------
def trailing_mdd(prices: pd.DataFrame, window: int) -> pd.DataFrame:
    """值越接近 0 = 回撤越淺。window 內以當前窗口嘅 running peak 計。"""
    n, m = prices.shape
    out = np.full((n, m), np.nan)
    arr = prices.to_numpy(dtype=float)
    for j in range(m):
        col = arr[:, j]
        if n < window:
            continue
        w = sliding_window_view(col, window)               # (n-window+1, window)；窗口含 NaN → 該日訊號 NaN
        peak = np.maximum.accumulate(w, axis=1)
        out[window - 1:, j] = (w / peak - 1.0).min(axis=1)
    return pd.DataFrame(out, index=prices.index, columns=prices.columns)


# ---------- 回測引擎 ----------
def run_strategy(prices: pd.DataFrame, window: int, top: int, rebalance: int,
                 cost_bps: float) -> pd.DataFrame:
    """每 `rebalance` 日（signal 日 t）揀 MDD 最淺嘅 top 隻，t+1 收市入場，持有到下一次入場。

    回傳以日為單位嘅 DataFrame：strat（已扣成本）、bench（全 universe 等權，唔扣成本）、
    period（持有期編號，用做 cluster）。
    """
    mdd = trailing_mdd(prices, window)
    rets = prices.pct_change(fill_method=None)
    idx = prices.index
    sig_days = list(range(window - 1, len(idx) - 2, rebalance))       # 訊號日 index
    cost_rt = cost_bps / 1e4
    w_prev = pd.Series(0.0, index=prices.columns)
    rows = []
    for k, s in enumerate(sig_days):
        entry = s + 1                                                  # t+1 收市入場
        exit_ = (sig_days[k + 1] + 1) if k + 1 < len(sig_days) else len(idx) - 1
        if exit_ <= entry:
            continue
        sig = mdd.iloc[s].dropna()
        elig = sig.index[prices.iloc[entry][sig.index].notna()]
        if len(elig) < max(top * 2, 10):
            continue
        sel = sig[elig].sort_values(ascending=False).index[:top]     # 越接近 0 越好
        w_new = pd.Series(0.0, index=prices.columns)
        w_new[sel] = 1.0 / len(sel)
        b_new = pd.Series(0.0, index=prices.columns)
        b_new[elig] = 1.0 / len(elig)
        turnover = (w_new - w_prev).abs().sum() / 2                    # 單邊換倉比例
        cost = turnover * cost_rt                                      # 買 x + 賣 x = 一個來回
        seg = rets.iloc[entry + 1: exit_ + 1]                          # 入場後逐日報酬
        # 買入持有（唔每日再平衡）：以 entry 價為 1 嘅累積價值
        growth = (1 + seg.fillna(0)).cumprod()
        v_s = (growth * w_new).sum(axis=1)
        v_b = (growth * b_new).sum(axis=1)
        d_s = v_s.pct_change().fillna(v_s - 1.0)
        d_b = v_b.pct_change().fillna(v_b - 1.0)
        d_s.iloc[0] -= cost                                            # 成本計喺入場後第一日
        # 持有期尾嘅自然漂移權重（用嚟計下次換倉量）
        w_prev = (growth.iloc[-1] * w_new) / v_s.iloc[-1]
        rows.append(pd.DataFrame({"strat": d_s, "bench": d_b, "period": k}))
    if not rows:
        return pd.DataFrame(columns=["strat", "bench", "period"])
    return pd.concat(rows)


# ---------- 統計 ----------
def newey_west_t(x: np.ndarray, lag: int) -> float:
    x = np.asarray(x, dtype=float)
    n = len(x)
    if n < lag + 5:
        return float("nan")
    xm = x - x.mean()
    gamma0 = (xm @ xm) / n
    s = gamma0
    for l in range(1, lag + 1):
        w = 1 - l / (lag + 1)
        s += 2 * w * (xm[l:] @ xm[:-l]) / n
    if not s > 0:
        return float("nan")
    return float(x.mean() / math.sqrt(s / n))


def period_returns(daily: pd.DataFrame) -> pd.DataFrame:
    g = daily.groupby("period")
    comp = lambda c: g[c].apply(lambda s: float((1 + s).prod() - 1))
    out = pd.DataFrame({"strat": comp("strat"), "bench": comp("bench")})
    out["excess"] = out["strat"] - out["bench"]
    return out


def block_t(x: np.ndarray) -> float:
    x = np.asarray(x, dtype=float)
    if len(x) < 3 or not x.std(ddof=1) > 0:
        return float("nan")
    return float(x.mean() / (x.std(ddof=1) / math.sqrt(len(x))))


def maxdd(r: pd.Series) -> float:
    c = (1 + r).cumprod()
    return float((c / c.cummax() - 1).min())


def summarize(daily: pd.DataFrame, label: str) -> dict:
    if daily.empty:
        return {"label": label, "n_days": 0}
    pr = period_returns(daily)
    ex_daily = (daily["strat"] - daily["bench"]).to_numpy()
    cum = lambda c: float((1 + daily[c]).prod() - 1)
    yrs = len(daily) / TRADING_DAYS
    ann = lambda c: float((1 + daily[c]).prod() ** (1 / yrs) - 1) if yrs > 0 else float("nan")
    return {
        "label": label, "n_days": len(daily), "n_periods": len(pr),
        "strat_cum": cum("strat"), "bench_cum": cum("bench"),
        "strat_ann": ann("strat"), "strat_mdd": maxdd(daily["strat"]), "bench_mdd": maxdd(daily["bench"]),
        "t_abs": block_t(period_returns(daily)["strat"].to_numpy()),
        "excess_mean_period": float(pr["excess"].mean()),
        "t_excess_block": block_t(pr["excess"].to_numpy()),
        "t_excess_nw": newey_west_t(ex_daily, lag=10),
        "excess_period_sd": float(pr["excess"].std(ddof=1)) if len(pr) > 1 else float("nan"),
    }


def fmt(s: dict) -> str:
    if not s.get("n_days"):
        return f"{s['label']}: （冇數據）"
    f = lambda v, p=2: "—" if v is None or (isinstance(v, float) and math.isnan(v)) else f"{v * 100:.{p}f}%"
    g = lambda v: "—" if v is None or (isinstance(v, float) and math.isnan(v)) else f"{v:.2f}"
    return (f"{s['label']:<26} {s['n_days']:>4}日 {s['n_periods']:>3}期 | 策略 {f(s['strat_cum'])} (MDD {f(s['strat_mdd'])}) "
            f"vs 等權 {f(s['bench_cum'])} (MDD {f(s['bench_mdd'])}) | 每期超額 {f(s['excess_mean_period'])} "
            f"| t(絕對) {g(s['t_abs'])} t(超額,區塊) {g(s['t_excess_block'])} t(超額,NW) {g(s['t_excess_nw'])}")


# ---------- walk-forward：W 只用已完結嘅持有期揀 ----------
def walk_forward(prices: pd.DataFrame, windows: list[int], top: int, rebalance: int,
                 cost_bps: float, folds: int, min_train_frac: float):
    runs = {w: run_strategy(prices, w, top, rebalance, cost_bps) for w in windows}
    # 對齊到所有 W 都有數據嘅日期（最長 W 嘅 warmup 之後）
    common = None
    for d in runs.values():
        common = d.index if common is None else common.intersection(d.index)
    if common is None or len(common) < 60:
        raise SystemExit("數據太短，做唔到 walk-forward（要 > 約 60 個共同交易日）。")
    start = common.min()
    # 以最長 W 嘅持有期編號做 fold 邊界
    ref_w = max(windows)
    ref = runs[ref_w]
    ref_periods = sorted(ref["period"].unique())
    n_p = len(ref_periods)
    n_train = max(3, int(n_p * min_train_frac))
    test_periods = ref_periods[n_train:]
    if len(test_periods) < folds:
        folds = max(1, len(test_periods))
    chunks = np.array_split(test_periods, folds)
    # 每個 fold 開始日 = 該 fold 第一個持有期嘅第一日
    pk = ref.groupby("period").apply(lambda g: g.index.min())
    results, oos_parts, bench_parts = [], [], []
    for k, ch in enumerate(chunks):
        f_start = pk[ch[0]]
        f_end = ref[ref["period"] == ch[-1]].index.max()
        # 揀 W：只用「完結早過 f_start」嘅持有期
        best_w, best_score = None, -np.inf
        for w in windows:
            d = runs[w]
            tr = d[(d.index < f_start) & (d.index >= start)]
            if tr.empty:
                continue
            tr_pr = period_returns(tr)
            score = float(tr_pr["excess"].mean())
            if score > best_score:
                best_w, best_score = w, score
        d = runs[best_w]
        oos = d[(d.index >= f_start) & (d.index <= f_end)]
        results.append((k, best_w, best_score, f_start, f_end, oos))
        oos_parts.append(oos[["strat", "bench"]].assign(period=k * 1000 + oos["period"]))
    return runs, results, pd.concat(oos_parts) if oos_parts else pd.DataFrame()


def power_note(sd: float, mean: float, n_have: int, rebalance: int) -> str:
    if not (sd > 0) or not mean or mean <= 0:
        return "超額平均 ≤ 0 或波動為 0，power 計算冇意義。"
    need = math.ceil((2.0 * sd / mean) ** 2)
    years = need * rebalance / TRADING_DAYS
    return (f"以觀察到嘅每期超額 {mean * 100:.2f}% / 標準差 {sd * 100:.2f}% 計，"
            f"要 |t| = 2 需要約 {need} 個持有期（≈ {years:.1f} 年）；而家得 {n_have} 期。")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--prices", help="prices_<日>.csv 路徑")
    ap.add_argument("--top", type=int, default=10, help="揀幾多隻（預設 10）")
    ap.add_argument("--rebalance", type=int, default=21, help="換倉間隔（交易日，預設 21）")
    ap.add_argument("--windows", default="63,126", help="MDD 回望窗口候選（逗號分隔，預設 63,126）")
    ap.add_argument("--cost-bps", type=float, default=30.0, help="來回成本 bps（預設 30，港股；美股可試 10）")
    ap.add_argument("--folds", type=int, default=3, help="OOS fold 數（預設 3）")
    ap.add_argument("--min-train-frac", type=float, default=0.3, help="首段只作 training 嘅持有期比例（預設 0.3）")
    ap.add_argument("--selftest", action="store_true", help="合成數據自測")
    a = ap.parse_args(argv)
    if a.selftest:
        return selftest()
    if not a.prices:
        ap.error("要 --prices 或 --selftest")
    windows = [int(x) for x in a.windows.split(",")]
    prices = load_prices(a.prices)
    print(f"數據：{prices.shape[1]} 隻 × {prices.shape[0]} 日（{prices.index[0].date()} → {prices.index[-1].date()}），"
          f"成本 {a.cost_bps:g} bps 來回，top {a.top}，每 {a.rebalance} 日換倉\n")
    runs, res, oos = walk_forward(prices, windows, a.top, a.rebalance, a.cost_bps, a.folds, a.min_train_frac)
    print("== 各窗口全樣本（無揀選，只供參考；窗口數 =", len(windows), "，有多重比較）==")
    for w, d in runs.items():
        print(fmt(summarize(d, f"W={w}")))
    print("\n== Walk-forward（W 只用已完結持有期揀）==")
    for k, w, score, s, e, o in res:
        print(fmt(summarize(o, f"fold{k + 1} W={w}")) +
              f"  [{s.date()}→{e.date()}，IS 每期超額 {score * 100:.2f}%]")
    total = summarize(oos, "OOS 串連")
    print("\n" + fmt(total))
    print("\n判讀：t(絕對) < 1.65 = 絕對回報冇足夠證據；t(超額) 係「跑贏等權」嘅證據。")
    print("      兩個都夠先好講「有 edge」；只有超額 = 只係跌少啲（防守）。")
    print("\nPower：" + power_note(total.get("excess_period_sd", float("nan")),
                                   total.get("excess_mean_period", 0.0), total.get("n_periods", 0), a.rebalance))
    print("\n⚠️ Universe 係當日名單 → 倖存者偏差；樣本短；收市價成交。結果只係「值得繼續累積數據」，唔係買入訊號。")
    return 0


# ---------- 自測 ----------
def _synthetic(n=700, m=60, seed=0, edge=0.0):
    rng = np.random.default_rng(seed)
    idx = pd.bdate_range(end="2026-10-16", periods=n)
    vol = rng.uniform(0.008, 0.03, m)
    mu = edge * (0.03 - vol) / 0.02                    # 低波動股有額外 drift（edge>0 時）
    ret = rng.normal(mu - 0.5 * vol ** 2, vol, (n, m))   # 算術 drift = mu（避免 vol drag 令高波動股虛高）
    return pd.DataFrame(100 * np.exp(np.cumsum(ret, axis=0)), index=idx, columns=[f"S{j}" for j in range(m)])


def selftest() -> int:
    ok = True
    # 1) trailing_mdd：單調升 → 0；先升後跌 20% → -0.2
    p = pd.DataFrame({"a": [100, 110, 120, 96, 100, 101], "b": [1, 2, 3, 4, 5, 6]},
                     index=pd.bdate_range("2026-01-01", periods=6))
    m = trailing_mdd(p, 5)
    c1 = abs(m["b"].iloc[-1]) < 1e-12 and abs(m["a"].iloc[-1] - (96 / 120 - 1)) < 1e-12
    print("trailing_mdd 數值:", "OK" if c1 else "FAIL"); ok &= c1
    # 2) 無 edge：超額應接近 0，t 唔應該係大正數
    ts = []
    for s in range(12):
        d = run_strategy(_synthetic(seed=s), 63, 10, 21, 0)
        ts.append(summarize(d, "x")["t_excess_block"])
    mt = float(np.nanmean(ts))
    c2 = abs(mt) < 0.8
    print(f"無 edge（成本 0）：12 組隨機數據平均 t(超額) = {mt:.2f}", "OK" if c2 else "FAIL"); ok &= c2
    # 3) 有 edge（低波動 drift）：應該明顯正
    ts2 = []
    for s in range(12):
        d = run_strategy(_synthetic(seed=100 + s, edge=0.0015), 63, 10, 21, 30)
        ts2.append(summarize(d, "x")["t_excess_block"])
    mt2 = float(np.nanmean(ts2))
    c3 = mt2 > mt + 1.0
    print(f"有 edge（成本 30bps）：平均 t(超額) = {mt2:.2f}（要明顯高過無 edge）", "OK" if c3 else "FAIL"); ok &= c3
    # 4) 成本：成本愈高，策略報酬愈低
    d0 = run_strategy(_synthetic(seed=7), 63, 10, 21, 0)
    d1 = run_strategy(_synthetic(seed=7), 63, 10, 21, 100)
    c4 = (1 + d1["strat"]).prod() < (1 + d0["strat"]).prod()
    print("成本單調:", "OK" if c4 else "FAIL"); ok &= c4
    # 5) 防 look-ahead：未來數據改變唔影響過去訊號
    base = _synthetic(seed=3)
    alt = base.copy()
    alt.iloc[-50:] *= 3
    c5 = np.allclose(trailing_mdd(base, 63).iloc[:-50].to_numpy(), trailing_mdd(alt, 63).iloc[:-50].to_numpy(), equal_nan=True)
    print("訊號只用過去數據:", "OK" if c5 else "FAIL"); ok &= c5
    # 6) 全流程
    pr = _synthetic(seed=11, edge=0.001)
    runs, res, oos = walk_forward(pr, [63, 126], 10, 21, 30, 3, 0.3)
    c6 = len(res) == 3 and not oos.empty
    print("walk-forward 全流程:", "OK" if c6 else "FAIL"); ok &= c6
    print("\n" + ("全部通過" if ok else "有失敗"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
