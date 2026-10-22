#!/usr/bin/env python3
"""多因子機會掃描 — 用現有價格數據搵「最大而且可信」嘅獲利機會（只需 pandas + numpy）

做法：
  - 16 個價格因子（動量、反轉、低波動、低回撤、52 週高位、趨勢、Sharpe、4 個組合）
    × 3 個持有期（5 / 21 / 63 交易日），另加大市擇時（MA200）
  - t 日收市計訊號，t+1 收市入場，持有 H 日，持有期互不重疊；按換倉量扣來回成本
  - 同當日全 universe 等權比較（超額），亦報絕對回報同 MDD
  - 全部檢定一齊做 Holm 校正（家族錯誤率）+ BH；每個持有期組別計 Deflated Sharpe
  - 前半 / 後半樣本（IS / OOS）、逐年一致性、牛熊 regime 分拆
  - 「跟最近最好嗰個因子」嘅 walk-forward（只用已完結持有期揀），先係誠實嘅「最大機會」數字
  - 輸出每個因子今日嘅 Top N 名單，同所需期數（power）

用法：
  python3 analysis/opportunity_scan.py --selftest
  python3 analysis/opportunity_scan.py --prices prices_hk.csv --market hk --out results/scan-hk
  python3 analysis/opportunity_scan.py --prices prices_us.csv --market us --bench SPY --out results/scan-us
  python3 analysis/opportunity_scan.py --prices <csv> --market hk --membership membership_hk.csv   # point-in-time universe

prices CSV：第一欄日期，其餘每欄一隻股票收市價（quant-hk / quant-us 嘅 prices_<日>.csv，或 build_universe.py 下載嘅檔）。
membership CSV（可選）：ticker,first_seen — 只有 first_seen 當日或之後先可以被揀（減輕倖存者偏差）。

分級：
  PASS    持有期 ≥ 8、Holm 校正 p < 0.05、IS 同 OOS 超額都 > 0、OOS t ≥ 1、DSR ≥ 0.95、扣成本絕對回報 > 0
  WATCH   未校正 p < 0.05，而且 IS 同 OOS 超額都 > 0
  FAIL    其他
  UNGRADED 持有期 < 8
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from statistics import NormalDist

import numpy as np
import pandas as pd
from numpy.lib.stride_tricks import sliding_window_view

LOOKBACK = 253          # 所有因子共用起點，令各因子持有期對齊（meta walk-forward 需要）
MIN_PERIODS = 8         # 同 Dashboard FCFG.minWindows 一致
COST_DEFAULT = {"hk": 30.0, "us": 10.0}
BENCH_DEFAULT = {"hk": "2800.HK", "us": "SPY"}
ND = NormalDist()


# ---------- 數據 ----------
def load_prices(path: str, max_nan: float = 0.5) -> pd.DataFrame:
    df = pd.read_csv(path, index_col=0, parse_dates=True)
    df = df.sort_index()
    df = df[~df.index.duplicated(keep="last")]
    df = df.apply(pd.to_numeric, errors="coerce")
    df = df.loc[:, df.isna().mean() <= max_nan]   # 寬鬆：遲上市嘅股票都留，訊號未夠數據時自然係 NaN
    df = df.ffill(limit=3)
    return df.where(df > 0)


def load_membership(path: str) -> pd.Series:
    m = pd.read_csv(path)
    return pd.to_datetime(m.set_index("ticker")["first_seen"])


# ---------- 因子（score 越高越好；只用 t 日及之前）----------
def trailing_mdd(P: pd.DataFrame, w: int) -> pd.DataFrame:
    a = P.to_numpy(dtype=float)
    out = np.full(a.shape, np.nan)
    if len(a) >= w:
        win = sliding_window_view(a, w, axis=0)            # (n-w+1, m, w)
        peak = np.maximum.accumulate(win, axis=2)
        dd = np.nanmin(win / peak - 1, axis=2)
        dd[np.isnan(win).any(axis=2)] = np.nan
        out[w - 1:] = dd
    return pd.DataFrame(out, index=P.index, columns=P.columns)


def build_signals(P: pd.DataFrame) -> dict[str, pd.DataFrame]:
    r1 = P.pct_change(fill_method=None)
    S = {
        "mom_12_1": P.shift(21) / P.shift(252) - 1,
        "mom_6_1": P.shift(21) / P.shift(126) - 1,
        "mom_3m": P / P.shift(63) - 1,
        "rev_1w": -(P / P.shift(5) - 1),
        "rev_1m": -(P / P.shift(21) - 1),
        "lowvol_63": -r1.rolling(63, min_periods=50).std(),
        "lowvol_252": -r1.rolling(252, min_periods=200).std(),
        "lowmdd_63": trailing_mdd(P, 63),
        "lowmdd_126": trailing_mdd(P, 126),
        "lowmdd_252": trailing_mdd(P, 252),
        "hi52": P / P.rolling(252, min_periods=200).max(),
        "trend_200": P / P.rolling(200, min_periods=180).mean() - 1,
        "sharpe_252": r1.rolling(252, min_periods=200).mean() / r1.rolling(252, min_periods=200).std(),
    }
    rk = lambda k: S[k].rank(axis=1, pct=True)
    S["combo_lowvol_mom"] = rk("lowvol_252") + rk("mom_12_1")
    S["combo_lowmdd_mom"] = rk("lowmdd_252") + rk("mom_6_1")
    S["combo_hi52_lowvol"] = rk("hi52") + rk("lowvol_252")
    return S


# ---------- 統計 ----------
def _betacf(a, b, x, itmax=300, eps=3e-14):
    qab, qap, qam = a + b, a + 1, a - 1
    c, d = 1.0, 1 - qab * x / qap
    d = 1 / (d if abs(d) > 1e-300 else 1e-300)
    h = d
    for m in range(1, itmax + 1):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1 + aa * d; d = 1 / (d if abs(d) > 1e-300 else 1e-300)
        c = 1 + aa / c if abs(c) > 1e-300 else 1e-300
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1 + aa * d; d = 1 / (d if abs(d) > 1e-300 else 1e-300)
        c = 1 + aa / c if abs(c) > 1e-300 else 1e-300
        de = d * c
        h *= de
        if abs(de - 1) < eps:
            break
    return h


def _betai(a, b, x):
    if x <= 0: return 0.0
    if x >= 1: return 1.0
    lbt = math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * math.log(x) + b * math.log(1 - x)
    bt = math.exp(lbt)
    if x < (a + 1) / (a + b + 2):
        return bt * _betacf(a, b, x) / a
    return 1 - bt * _betacf(b, a, 1 - x) / b


def t_sf(t: float, df: int) -> float:
    """單尾 p = P(T > t)"""
    if not np.isfinite(t) or df < 1:
        return float("nan")
    p_two_tail_half = 0.5 * _betai(df / 2, 0.5, df / (df + t * t))
    return p_two_tail_half if t > 0 else 1 - p_two_tail_half


def t_stat(x) -> float:
    x = np.asarray(x, float); x = x[np.isfinite(x)]
    if len(x) < 3: return float("nan")
    sd = x.std(ddof=1)
    return float(x.mean() / (sd / math.sqrt(len(x)))) if sd > 0 else float("nan")


def nw_t(x, lag=None) -> float:
    x = np.asarray(x, float); x = x[np.isfinite(x)]
    n = len(x)
    if n < 5: return float("nan")
    lag = lag if lag is not None else max(1, int(n ** 0.25))
    e = x - x.mean()
    s = (e @ e) / n
    for k in range(1, lag + 1):
        s += 2 * (1 - k / (lag + 1)) * (e[k:] @ e[:-k]) / n
    return float(x.mean() / math.sqrt(s / n)) if s > 0 else float("nan")


def holm(p: list[float]) -> list[float]:
    idx = [i for i, v in enumerate(p) if np.isfinite(v)]
    m = len(idx)
    out = [float("nan")] * len(p)
    run = 0.0
    for rank, i in enumerate(sorted(idx, key=lambda i: p[i])):
        run = max(run, min(1.0, (m - rank) * p[i]))
        out[i] = run
    return out


def bh(p: list[float]) -> list[float]:
    idx = [i for i, v in enumerate(p) if np.isfinite(v)]
    m = len(idx)
    out = [float("nan")] * len(p)
    run = 1.0
    for rank, i in reversed(list(enumerate(sorted(idx, key=lambda i: p[i])))):
        run = min(run, p[i] * m / (rank + 1))
        out[i] = run
    return out


def deflated_sharpe(x, n_trials: int) -> float:
    """Bailey & López de Prado (2014)：喺 n_trials 次嘗試之後，SR 真係 > 0 嘅機率。
    SR0 = n_trials 個「冇 edge」檢定入面預期最大嘅 SR；虛無假設下 SR 估計嘅方差 ≈ 1/T。
    （唔用各因子 SR 嘅實際方差：反轉同動量係鏡像，真有 edge 時會將方差谷大，DSR 失效。）"""
    x = np.asarray(x, float); x = x[np.isfinite(x)]
    T = len(x)
    if T < 5 or x.std(ddof=1) == 0: return float("nan")
    sr = x.mean() / x.std(ddof=1)
    g = 0.5772156649
    sr_var = 1 / T
    if n_trials > 1:
        sr0 = math.sqrt(sr_var) * ((1 - g) * ND.inv_cdf(1 - 1 / n_trials) + g * ND.inv_cdf(1 - 1 / (n_trials * math.e)))
    else:
        sr0 = 0.0
    sk = float(pd.Series(x).skew()); ku = float(pd.Series(x).kurt()) + 3
    den = 1 - sk * sr + (ku - 1) / 4 * sr * sr
    if den <= 0: return float("nan")
    return ND.cdf((sr - sr0) * math.sqrt(T - 1) / math.sqrt(den))


def max_dd(r) -> float:
    eq = np.cumprod(1 + np.asarray(r, float))
    return float((eq / np.maximum.accumulate(eq) - 1).min()) if len(eq) else float("nan")


# ---------- 回測 ----------
def rebalance_points(n: int, H: int, start: int) -> list[int]:
    return list(range(start, n - 1 - H, H))


def eligible_mask(P: pd.DataFrame, membership: pd.Series | None) -> pd.DataFrame | None:
    if membership is None: return None
    fs = membership.reindex(P.columns)
    return pd.DataFrame({c: P.index >= fs[c] if pd.notna(fs[c]) else np.zeros(len(P), bool) for c in P.columns}, index=P.index)


def backtest(P: pd.DataFrame, sig: pd.DataFrame, H: int, top: int, cost_rt: float, start: int,
             elig: pd.DataFrame | None = None) -> pd.DataFrame:
    Pff = P.ffill()       # 出場：之前停牌／除牌就用最後一個有效價（唔可以靠未來資料剔走）
    A, Aff, Sg = P.to_numpy(float), Pff.to_numpy(float), sig.to_numpy(float)
    E = elig.to_numpy(bool) if elig is not None else None
    cols = np.asarray(P.columns)
    rows, prev = [], set()
    for i in rows_idx(len(P), H, start):
        s, en, ex = Sg[i], A[i + 1], Aff[i + 1 + H]
        ok = np.isfinite(s) & np.isfinite(en) & np.isfinite(ex)
        if E is not None: ok &= E[i]
        if ok.sum() < 2 * top:
            continue
        ret = ex[ok] / en[ok] - 1
        order = np.argsort(-s[ok], kind="stable")
        picks = set(cols[ok][order[:top]])
        port = ret[order[:top]].mean()
        bottom = ret[order[-top:]].mean()
        turn = 1 - len(picks & prev) / top
        prev = picks
        net = port - cost_rt * turn
        ew = ret.mean()
        rows.append({"date": P.index[i], "net": net, "ew": ew, "excess": net - ew,
                     "ls": port - bottom - 2 * cost_rt * turn, "turnover": turn, "n": int(ok.sum())})
    return pd.DataFrame(rows)


def rows_idx(n, H, start):
    return rebalance_points(n, H, start)


def market_index(P: pd.DataFrame, bench: str | None) -> pd.Series:
    if bench and bench in P.columns and P[bench].notna().mean() > 0.9:
        return P[bench].ffill()
    r = P.pct_change(fill_method=None).mean(axis=1).fillna(0)
    return (1 + r).cumprod()


def timing_backtest(P: pd.DataFrame, idx: pd.Series, H: int, cost_rt: float, start: int) -> pd.DataFrame:
    """大市 > MA200 就持有全 universe 等權，否則現金；超額 = 對比一直持有等權"""
    ma = idx.rolling(200, min_periods=180).mean()
    Pff = P.ffill()
    A, Aff = P.to_numpy(float), Pff.to_numpy(float)
    rows, prev_on = [], None
    for i in rows_idx(len(P), H, start):
        en, ex = A[i + 1], Aff[i + 1 + H]
        ok = np.isfinite(en) & np.isfinite(ex)
        if ok.sum() < 5 or not np.isfinite(ma.iloc[i]):
            continue
        ew = (ex[ok] / en[ok] - 1).mean()
        on = bool(idx.iloc[i] > ma.iloc[i])
        switch = 0.0 if prev_on is None or prev_on == on else 1.0
        prev_on = on
        net = (ew if on else 0.0) - cost_rt * switch
        rows.append({"date": P.index[i], "net": net, "ew": ew, "excess": net - ew, "ls": np.nan,
                     "turnover": switch, "n": int(ok.sum()), "on": on})
    return pd.DataFrame(rows)


def regime_series(idx: pd.Series) -> pd.Series:
    return idx > idx.rolling(200, min_periods=180).mean()


# ---------- 單一檢定摘要 ----------
def summarize(bt: pd.DataFrame, H: int, regime: pd.Series) -> dict:
    n = len(bt)
    if n == 0:
        return {"periods": 0}
    x = bt["excess"].to_numpy()
    half = n // 2
    t = t_stat(x)
    per_year = 252 / H
    yr = bt.groupby(bt["date"].dt.year)["excess"].mean()
    reg = regime.reindex(bt["date"]).to_numpy()
    sd = x.std(ddof=1) if n > 1 else float("nan")
    m = x.mean()
    out = {
        "periods": n,
        "excess_mean": m,
        "excess_t": t,
        "excess_t_nw": nw_t(x),
        "p": t_sf(t, n - 1),
        "is_mean": x[:half].mean() if half else float("nan"),
        "oos_mean": x[half:].mean(),
        "oos_t": t_stat(x[half:]),
        "abs_mean": bt["net"].mean(),
        "abs_ann": (1 + bt["net"]).prod() ** (per_year / n) - 1,
        "ew_ann": (1 + bt["ew"]).prod() ** (per_year / n) - 1,
        "mdd": max_dd(bt["net"]),
        "ew_mdd": max_dd(bt["ew"]),
        "ls_mean": bt["ls"].mean(),
        "ls_t": t_stat(bt["ls"]),
        "turnover": bt["turnover"].mean(),
        "years_pos": f"{int((yr > 0).sum())}/{len(yr)}",
        "bull_mean": float(np.nanmean(np.where(reg == True, x, np.nan))) if (reg == True).any() else float("nan"),
        "bear_mean": float(np.nanmean(np.where(reg == False, x, np.nan))) if (reg == False).any() else float("nan"),
        "needed": math.ceil((2 * sd / m) ** 2) if m > 0 and sd > 0 else None,
        "sr": m / sd if sd and sd > 0 else float("nan"),
    }
    return out


def grade(r: dict) -> str:
    if r["periods"] < MIN_PERIODS:
        return "UNGRADED"
    if (r["holm"] < 0.05 and r["is_mean"] > 0 and r["oos_mean"] > 0 and r.get("oos_t", 0) >= 1
            and (r.get("dsr") or 0) >= 0.95 and r["abs_mean"] > 0):
        return "PASS"
    if r["p"] < 0.05 and r["is_mean"] > 0 and r["oos_mean"] > 0:
        return "WATCH"
    return "FAIL"


# ---------- meta：每期跟「到目前為止最好」嘅因子 ----------
def meta_walk_forward(bts: dict[str, pd.DataFrame], min_hist: int = 6) -> pd.DataFrame:
    frames = {k: v.set_index("date")["excess"] for k, v in bts.items() if len(v)}
    nets = {k: v.set_index("date")["net"] for k, v in bts.items() if len(v)}
    if not frames: return pd.DataFrame()
    X = pd.DataFrame(frames).sort_index()
    N = pd.DataFrame(nets).sort_index()
    rows = []
    for k in range(len(X)):
        hist = X.iloc[: max(0, k - 1)]      # 第 k-1 期喺第 k 期入場時仲未完結 → 只用到 k-2
        if len(hist) < min_hist: continue
        mean = hist.mean()
        mean = mean[X.iloc[k].notna()]
        if mean.dropna().empty: continue
        pick = mean.idxmax()
        rows.append({"date": X.index[k], "pick": pick, "excess": X.iloc[k][pick], "net": N.iloc[k][pick]})
    return pd.DataFrame(rows)


# ---------- 今日名單 ----------
def todays_picks(P: pd.DataFrame, sig: pd.DataFrame, top: int, elig: pd.DataFrame | None) -> list[tuple[str, float]]:
    s = sig.iloc[-1].copy()
    s[~np.isfinite(P.iloc[-1].to_numpy(float))] = np.nan
    if elig is not None: s[~elig.iloc[-1].to_numpy(bool)] = np.nan
    s = s.dropna().sort_values(ascending=False)
    return [(t, float(v)) for t, v in s.head(top).items()]


# ---------- 主程序 ----------
def run(P: pd.DataFrame, market: str, horizons: list[int], top: int, cost_bps: float,
        bench: str | None, membership: pd.Series | None) -> dict:
    cost = cost_bps / 1e4
    S = build_signals(P)
    elig = eligible_mask(P, membership)
    idx = market_index(P, bench)
    regime = regime_series(idx)
    univ = [c for c in P.columns if c != bench]
    Pu = P[univ]
    Su = {k: v[univ] for k, v in S.items()}
    eu = elig[univ] if elig is not None else None

    results, bts_by_h = [], {}
    for H in horizons:
        bts_by_h[H] = {}
        for name, sig in Su.items():
            bt = backtest(Pu, sig, H, top, cost, LOOKBACK, eu)
            bts_by_h[H][name] = bt
            results.append({"test": f"{name}@{H}", "signal": name, "H": H, **summarize(bt, H, regime)})
        tb = timing_backtest(Pu, idx, H, cost, LOOKBACK)
        bts_by_h[H]["timing_ma200"] = tb
        results.append({"test": f"timing_ma200@{H}", "signal": "timing_ma200", "H": H, **summarize(tb, H, regime)})

    # 家族校正（全部可評級檢定）
    gradable = [r for r in results if r["periods"] >= MIN_PERIODS]
    adj_h = holm([r["p"] for r in gradable]); adj_b = bh([r["p"] for r in gradable])
    for r, a, b in zip(gradable, adj_h, adj_b):
        r["holm"], r["bh"] = a, b
    for H in horizons:
        grp = [r for r in gradable if r["H"] == H and np.isfinite(r.get("sr", np.nan))]
        for r in grp:
            r["dsr"] = deflated_sharpe(bts_by_h[H][r["signal"]]["excess"], len(grp))
    for r in results:
        r.setdefault("holm", float("nan")); r.setdefault("bh", float("nan")); r.setdefault("dsr", float("nan"))
        r["grade"] = grade(r) if r["periods"] else "UNGRADED"

    metas = []
    for H in horizons:
        mw = meta_walk_forward({k: v for k, v in bts_by_h[H].items() if k != "timing_ma200"})
        if len(mw):
            x = mw["excess"].to_numpy()
            t = t_stat(x)
            metas.append({"H": H, "periods": len(mw), "excess_mean": float(x.mean()), "excess_t": t,
                          "p": t_sf(t, len(x) - 1), "abs_mean": float(mw["net"].mean()),
                          "mdd": max_dd(mw["net"]), "last_pick": mw["pick"].iloc[-1],
                          "picks": mw["pick"].value_counts().head(5).to_dict()})

    picks = {k: todays_picks(Pu, v, top, eu) for k, v in Su.items()}
    on = bool(regime.iloc[-1]) if pd.notna(regime.iloc[-1]) else None
    return {
        "market": market, "asof": str(P.index[-1].date()), "start": str(P.index[0].date()),
        "days": len(P), "tickers": len(univ), "top": top, "cost_bps": cost_bps,
        "bench": bench if bench in P.columns else "EW universe", "membership": membership is not None,
        "regime_bull": on, "results": results, "meta": metas, "picks": picks,
        "n_tests": len(gradable),
    }


def f(v, pct=False, d=2):
    if v is None or (isinstance(v, float) and not np.isfinite(v)): return "—"
    return f"{v * 100:.{d}f}%" if pct else f"{v:.{d}f}"


def report_md(R: dict) -> str:
    L = []
    rs = sorted(R["results"], key=lambda r: (-{"PASS": 3, "WATCH": 2, "FAIL": 1, "UNGRADED": 0}[r["grade"]],
                                             -(r.get("excess_t") if np.isfinite(r.get("excess_t", np.nan)) else -99)))
    cnt = {g: sum(r["grade"] == g for r in rs) for g in ["PASS", "WATCH", "FAIL", "UNGRADED"]}
    L.append(f"# 機會掃描：{R['market'].upper()}（數據 {R['start']} → {R['asof']}，{R['days']} 日 × {R['tickers']} 隻）\n")
    L.append(f"- Top {R['top']} 等權、來回成本 {R['cost_bps']:.0f} bps、基準：{R['bench']}、point-in-time universe：{'有' if R['membership'] else '冇（有倖存者偏差）'}")
    L.append(f"- 可評級檢定 {R['n_tests']} 個；PASS {cnt['PASS']}、WATCH {cnt['WATCH']}、FAIL {cnt['FAIL']}、UNGRADED {cnt['UNGRADED']}")
    L.append(f"- 大市今日：{'MA200 之上（牛）' if R['regime_bull'] else 'MA200 之下（熊）' if R['regime_bull'] is not None else '未知'}\n")
    L.append("## 全部檢定（按分級、超額 t 排）\n")
    L.append("| 檢定 | 級 | 期數 | 每期超額 | t | NW t | Holm p | DSR | IS | OOS | OOS t | 年化 | 等權年化 | MDD | 牛市超額 | 熊市超額 | 正年份 | 換手 | 需期數 |")
    L.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for r in rs:
        if not r["periods"]:
            L.append(f"| {r['test']} | UNGRADED | 0 |" + " — |" * 16); continue
        L.append(f"| {r['test']} | {r['grade']} | {r['periods']} | {f(r['excess_mean'], 1)} | {f(r['excess_t'])} | {f(r['excess_t_nw'])} | "
                 f"{f(r['holm'], d=3)} | {f(r['dsr'])} | {f(r['is_mean'], 1)} | {f(r['oos_mean'], 1)} | {f(r['oos_t'])} | "
                 f"{f(r['abs_ann'], 1, 1)} | {f(r['ew_ann'], 1, 1)} | {f(r['mdd'], 1, 1)} | {f(r['bull_mean'], 1)} | {f(r['bear_mean'], 1)} | "
                 f"{r['years_pos']} | {f(r['turnover'])} | {r['needed'] or '—'} |")
    L.append("\n## 跟「到目前為止最好」嘅因子（walk-forward，只用已完結持有期揀）\n")
    L.append("呢個先係誠實嘅「最大機會」數字：佢包含咗「揀因子」嗰一步嘅運氣。\n")
    L.append("| 持有期 | 期數 | 每期超額 | t | p | 每期絕對 | MDD | 最新揀中 | 最常揀 |")
    L.append("|---|---|---|---|---|---|---|---|---|")
    for m in R["meta"]:
        L.append(f"| {m['H']} 日 | {m['periods']} | {f(m['excess_mean'], 1)} | {f(m['excess_t'])} | {f(m['p'], d=3)} | "
                 f"{f(m['abs_mean'], 1)} | {f(m['mdd'], 1, 1)} | {m['last_pick']} | {', '.join(f'{k}×{v}' for k, v in m['picks'].items())} |")
    L.append("\n## 今日名單（只列 PASS / WATCH 嘅因子；FAIL 嘅唔好跟）\n")
    shown = set()
    for r in rs:
        if r["grade"] in ("PASS", "WATCH") and r["signal"] in R["picks"] and r["signal"] not in shown:
            shown.add(r["signal"])
            L.append(f"- **{r['signal']}**（{r['grade']}，最佳持有期 {r['H']} 日）：" + "、".join(t for t, _ in R["picks"][r["signal"]]))
    if not shown:
        L.append("- 冇因子達 WATCH 或以上。")
    L.append("\n## 注意\n")
    L.append("- Holm 係對全部檢定一齊校正；DSR 係同一持有期組別內、計埋試咗幾多個因子之後 SR > 0 嘅機率。")
    L.append("- IS / OOS = 前半 / 後半持有期；正年份 = 每期超額平均 > 0 嘅曆年數。")
    L.append("- 「需期數」= 以現時均值同標準差，要幾多期先夠 |t| = 2。")
    if not R["membership"]:
        L.append("- **冇 point-in-time universe**：名單係今日嘅 most-active，過往跌出榜嘅股票唔喺度，動量／低回撤類結果會偏好。")
    return "\n".join(L) + "\n"


def _clean(o):
    if isinstance(o, dict): return {str(k): _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)): return [_clean(v) for v in o]
    if isinstance(o, (np.floating, float)): return None if not np.isfinite(o) else float(o)
    if isinstance(o, (np.integer,)): return int(o)
    if isinstance(o, np.bool_): return bool(o)
    return o


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--prices")
    ap.add_argument("--market", choices=["hk", "us"], default="hk")
    ap.add_argument("--bench", help="大市指數 ticker（預設 hk=2800.HK、us=SPY；唔喺檔就用等權指數）")
    ap.add_argument("--top", type=int, default=10)
    ap.add_argument("--horizons", default="5,21,63")
    ap.add_argument("--cost-bps", type=float, help="來回成本（預設 hk 30、us 10）")
    ap.add_argument("--membership", help="ticker,first_seen CSV（point-in-time universe）")
    ap.add_argument("--out", help="輸出資料夾（report.md + results.json）")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args(argv)
    if a.selftest:
        return selftest()
    if not a.prices:
        ap.error("要 --prices 或 --selftest")
    P = load_prices(a.prices)
    if len(P) < LOOKBACK + 2 * 21:
        print(f"⚠️ 只有 {len(P)} 日數據，最少要 {LOOKBACK + 42} 日（因子回望 {LOOKBACK} 日）", file=sys.stderr)
        return 2
    mem = load_membership(a.membership) if a.membership else None
    R = run(P, a.market, [int(h) for h in a.horizons.split(",")], a.top,
            a.cost_bps if a.cost_bps is not None else COST_DEFAULT[a.market],
            a.bench or BENCH_DEFAULT[a.market], mem)
    md = report_md(R)
    print(md)
    if a.out:
        os.makedirs(a.out, exist_ok=True)
        with open(os.path.join(a.out, "report.md"), "w", encoding="utf-8") as fh: fh.write(md)
        with open(os.path.join(a.out, "results.json"), "w", encoding="utf-8") as fh:
            json.dump(_clean(R), fh, ensure_ascii=False, indent=1, default=str)
        print(f"已寫 {a.out}/report.md、results.json")
    return 0


# ---------- 自測 ----------
def _synthetic(n=1500, m=80, seed=0, persist=0.0):
    rng = np.random.default_rng(seed)
    drift = rng.normal(0, persist, m)
    rets = np.empty((n, m))
    for t in range(n):
        drift = 0.998 * drift + math.sqrt(1 - 0.998 ** 2) * rng.normal(0, persist, m) if persist else drift
        rets[t] = 0.0003 + drift + rng.normal(0, 0.02, m) + rng.normal(0, 0.01)   # 個股 + 大市共同因子
    P = 50 * np.cumprod(1 + rets, axis=0)
    idx = pd.bdate_range("2019-01-01", periods=n)
    return pd.DataFrame(P, index=idx, columns=[f"T{i:03d}" for i in range(m)])


def selftest() -> int:
    ok = True

    def check(cond, msg):
        nonlocal ok
        print(("  ✓ " if cond else "  ✘ ") + msg)
        ok &= bool(cond)

    print("selftest")
    # 1. 冇 look-ahead：截斷至第 k 日計出嚟嘅訊號 == 全樣本第 k 日
    P = _synthetic(n=600, m=30, seed=1)
    full = build_signals(P)
    k = 450
    part = build_signals(P.iloc[: k + 1])
    same = all(np.allclose(full[s].iloc[k].to_numpy(float), part[s].iloc[k].to_numpy(float), equal_nan=True) for s in full)
    check(same, "所有因子只用 t 日及之前數據（截斷測試）")

    # 2. 統計函數
    check(abs(t_sf(2.0, 10) - 0.03669) < 1e-4, "Student-t 單尾 p（t=2, df=10 → 0.0367）")
    check(holm([0.01, 0.04, 0.03]) == [0.03, 0.06, 0.06], "Holm 校正")
    check(abs(bh([0.01, 0.04, 0.03])[0] - 0.03) < 1e-12, "BH 校正")

    # 3. 純噪音：唔應該有 PASS
    nulls = 0
    for seed in (2, 3):
        R = run(_synthetic(seed=seed), "hk", [5, 21, 63], 10, 30, None, None)
        nulls += sum(r["grade"] == "PASS" for r in R["results"])
    check(nulls == 0, f"純噪音數據（2 個 seed）冇 PASS（實得 {nulls}）")

    # 4. 植入持續 drift（動量有效）：動量類應該 PASS
    R = run(_synthetic(seed=4, persist=0.0012), "hk", [21], 10, 30, None, None)
    passed = {r["signal"] for r in R["results"] if r["grade"] == "PASS"}
    check(bool(passed & {"mom_12_1", "mom_6_1", "mom_3m", "hi52", "trend_200", "sharpe_252"}),
          f"植入動量 edge 被搵到（PASS：{sorted(passed) or '無'}）")
    check(R["meta"] and R["meta"][0]["excess_mean"] > 0, "meta walk-forward 喺有 edge 時超額 > 0")

    # 5. point-in-time：未 first_seen 嘅股票唔會入今日名單
    P = _synthetic(n=600, m=30, seed=5)
    mem = pd.Series(pd.Timestamp("2100-01-01"), index=P.columns); mem.iloc[:25] = P.index[0]
    el = eligible_mask(P, mem)
    pk = todays_picks(P, build_signals(P)["mom_3m"], 10, el)
    check(all(t in set(P.columns[:25]) for t, _ in pk), "membership 過濾生效")

    # 6. 報告可以生成
    check("機會掃描" in report_md(R), "report.md 生成")
    print("全部通過" if ok else "有失敗")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
