#!/usr/bin/env python3
"""下載「未復權」每日收市價，畀 scripts/backfill_prices.mjs 補 repo 空 close（只需 pandas + yfinance）

點解要未復權：repo 嘅 close 係「當日未復權收市」。用 prices_<日>.csv（整份復權）去補，遇到緊接缺口內有除息，
前後比例唔一致，核對唔過就唔補（US 2026-07-15 嗰 87 行就係咁）。未復權價（yfinance auto_adjust=False 嘅 Close，
只按拆股調整）唔受除息影響，比例核對會過；拆股嘅股票前後比例都係同一個整數，backfill 一樣按比例換算。
呢個唔係插補：補上去嘅係 Yahoo 嗰日嘅真實收市價，而且每隻股票仍然要通過 0.3% 前後比例核對，唔過就唔補。

用法：
  python3 analysis/download_raw_closes.py --market us            # → results/raw_closes_us_<日期>.csv
  node scripts/backfill_prices.mjs --prices results/raw_closes_us_<日期>.csv           # dry-run，睇可補幾多
  node scripts/backfill_prices.mjs --prices results/raw_closes_us_<日期>.csv --apply   # 寫 data/backfill/closes.csv
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import glob
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def repo_tickers(market: str) -> tuple[list[str], str]:
    ts, first = set(), "9999"
    for f in sorted(glob.glob(os.path.join(ROOT, "data", market, "*.csv"))):
        with open(f, newline="", encoding="utf-8") as fh:
            for r in csv.DictReader(fh):
                ts.add(r["ticker"])
                first = min(first, r["date"])
    return sorted(ts), first


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--market", choices=["hk", "us"], required=True)
    ap.add_argument("--out")
    a = ap.parse_args(argv)
    try:
        import yfinance as yf
    except ImportError:
        print("要 yfinance：python3 -m pip install yfinance（或用有 yfinance 嘅 venv）", file=sys.stderr)
        return 3
    tickers, first = repo_tickers(a.market)
    if not tickers:
        print(f"data/{a.market} 冇數據", file=sys.stderr)
        return 2
    start = (dt.date.fromisoformat(first) - dt.timedelta(days=7)).isoformat()
    end = (dt.date.today() + dt.timedelta(days=1)).isoformat()
    print(f"下載 {len(tickers)} 隻 {a.market.upper()}（{start} → 今日，auto_adjust=False）…")
    df = yf.download(tickers, start=start, end=end, interval="1d", auto_adjust=False, progress=False, threads=True)
    close = df["Close"] if hasattr(df.columns, "levels") else df[["Close"]].rename(columns={"Close": tickers[0]})
    close = close.dropna(how="all")
    miss = [t for t in tickers if t not in close.columns or close[t].notna().sum() == 0]
    out = a.out or os.path.join(ROOT, "results", f"raw_closes_{a.market}_{dt.date.today().isoformat()}.csv")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    close.to_csv(out, index_label="date", date_format="%Y-%m-%d")
    print(f"已寫 {os.path.relpath(out, ROOT)}：{len(close)} 日 × {close.shape[1]} 隻；下載唔到 {len(miss)} 隻" + (f"（{', '.join(miss[:20])}）" if miss else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
