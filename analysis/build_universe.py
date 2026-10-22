#!/usr/bin/env python3
"""由每日 metrics 名單建 point-in-time universe，並（可選）用 yfinance 下載長價格

點解要：prices_<日>.csv 只有「今日」most-active 名單，過去跌出榜嘅股票唔喺度（倖存者偏差）。
metrics_<dd-mm-YYYY>.csv 每日都記低當日名單，將佢哋合併就得到「曾經入過榜」嘅全部股票，
同埋每隻第一次入榜嘅日期（first_seen），opportunity_scan.py --membership 用佢限制「未入榜唔可以揀」。

用法：
  python3 analysis/build_universe.py --metrics ~/hermes-projects/quant-hk/output/data --market hk --out results/universe-hk
  python3 analysis/build_universe.py --metrics data/hk --market hk --out results/universe-hk          # repo 月檔都得
  python3 analysis/build_universe.py --metrics <dir> --market hk --out <dir> --download --period 6y  # 再用 yfinance 拉價

輸出：
  membership.csv          ticker,first_seen,last_seen,days_seen
  prices_union.csv        （--download）全部曾入榜股票 + 基準嘅日收市（auto_adjust=True，已調整拆股派息）
"""
from __future__ import annotations

import argparse
import glob
import os
import re
import sys

import pandas as pd

BENCH = {"hk": "2800.HK", "us": "SPY"}


def read_lists(path: str) -> pd.DataFrame:
    rows = []
    for f in sorted(glob.glob(os.path.join(os.path.expanduser(path), "*.csv"))):
        name = os.path.basename(f)
        m = re.match(r"metrics_(\d{2})-(\d{2})-(\d{4})\.csv$", name)
        try:
            df = pd.read_csv(f, usecols=lambda c: c in ("ticker", "date"))
        except Exception as e:                       # 壞檔唔好令成個流程停
            print(f"  跳過 {name}: {e}", file=sys.stderr)
            continue
        if "ticker" not in df:
            continue
        if m:                                        # 上游 metrics_<dd-mm-YYYY>.csv
            df["date"] = f"{m[3]}-{m[2]}-{m[1]}"
        elif "date" not in df:                       # repo data/<mkt>/YYYY-MM.csv 有 date 欄
            continue
        rows.append(df[["date", "ticker"]])
    if not rows:
        return pd.DataFrame(columns=["date", "ticker"])
    out = pd.concat(rows, ignore_index=True).dropna()
    out["date"] = pd.to_datetime(out["date"])
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--metrics", action="append", required=True, help="metrics 資料夾（可以重複畀幾個）")
    ap.add_argument("--market", choices=["hk", "us"], required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--download", action="store_true", help="用 yfinance 下載全部曾入榜股票嘅價格")
    ap.add_argument("--period", default="6y")
    ap.add_argument("--extra", default="", help="額外 ticker（逗號分隔），例如舊 prices 檔入面有但 metrics 冇嘅")
    a = ap.parse_args(argv)

    L = pd.concat([read_lists(p) for p in a.metrics], ignore_index=True)
    if L.empty:
        print("搵唔到任何名單（檢查 --metrics 路徑）", file=sys.stderr)
        return 2
    g = L.groupby("ticker")["date"]
    mem = pd.DataFrame({"first_seen": g.min(), "last_seen": g.max(), "days_seen": g.nunique()}).reset_index()
    for t in [x.strip() for x in a.extra.split(",") if x.strip()]:
        if t not in set(mem["ticker"]):
            mem.loc[len(mem)] = [t, L["date"].min(), L["date"].min(), 0]
    os.makedirs(a.out, exist_ok=True)
    mem.sort_values("ticker").to_csv(os.path.join(a.out, "membership.csv"), index=False, date_format="%Y-%m-%d")
    last = L["date"].max()
    dropped = mem[mem["last_seen"] < last]
    print(f"名單日數 {L['date'].nunique()}（{L['date'].min().date()} → {last.date()}），曾入榜 {len(mem)} 隻，"
          f"其中 {len(dropped)} 隻已跌出今日名單")
    if len(dropped):
        print("  跌出名單：" + ", ".join(dropped.sort_values("last_seen")["ticker"].head(40)))

    if a.download:
        try:
            import yfinance as yf
        except ImportError:
            print("要 yfinance：python3 -m pip install yfinance", file=sys.stderr)
            return 3
        tickers = sorted(set(mem["ticker"]) | {BENCH[a.market]})
        print(f"下載 {len(tickers)} 隻（period={a.period}）…")
        df = yf.download(tickers, period=a.period, interval="1d", auto_adjust=True, progress=False, threads=True)
        close = df["Close"] if isinstance(df.columns, pd.MultiIndex) else df[["Close"]].rename(columns={"Close": tickers[0]})
        close = close.dropna(how="all")
        miss = [t for t in tickers if t not in close.columns or close[t].notna().sum() == 0]
        close = close.drop(columns=[t for t in miss if t in close.columns])
        close.to_csv(os.path.join(a.out, "prices_union.csv"), date_format="%Y-%m-%d")
        print(f"已寫 prices_union.csv：{len(close)} 日 × {close.shape[1]} 隻；下載唔到 {len(miss)} 隻" +
              (f"（{', '.join(miss[:20])}）" if miss else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
