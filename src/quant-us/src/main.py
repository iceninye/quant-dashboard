#!/usr/bin/env python3
"""
US Quant Research v2.0 — 美股量化研究專案
Top 100 美股，Monte Carlo 模擬，Fan Chart，波動率曲面，HTML 報告。
"""

import sys
import os

# Ensure src/ is in path (matches Sentinel pattern)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# 確保可以 import 共用 report_deployer
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))

import argparse
import logging
import warnings
from datetime import datetime

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")

from config import CFG, BASE_DIR, OUTPUT_DIR, CHARTS_DIR, DATA_DIR, REPORTS_DIR, RAW_DIR, FALLBACK_TICKERS, BENCHMARK_TICKER
from core import (
    get_risk_free_rate, get_tickers, download_price_data, fetch_option_chain,
    calc_returns, calc_sharpe, calc_sortino, calc_max_drawdown,
    calc_max_dd_duration, calc_cagr, calc_calmar, calc_var,
    calc_parametric_var, calc_cvar, calc_beta,
    monte_carlo_gbm, generate_fan_chart, generate_vol_surface,
)
from generate_report import save_reports

TOP_N = CFG.top_n
LOOKBACK_DAYS = CFG.lookback_days
MONTE_CARLO_PATHS = CFG.sim_paths
MONTE_CARLO_HORIZON = CFG.sim_steps
RISK_FREE_RATE_FALLBACK = CFG.risk_free_rate_fallback

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("USQuant")


def main():
    parser = argparse.ArgumentParser(description="US Quant Research")
    parser.add_argument("--top-n", type=int, default=TOP_N)
    parser.add_argument("--no-scrape", action="store_true")
    parser.add_argument("--no-option", action="store_true")
    parser.add_argument("--html-report", action="store_true")
    parser.add_argument("--min-tickers", type=int, default=95, help="最低 ticker 數量，低於此值報錯退出")
    args = parser.parse_args()

    today = datetime.now().strftime("%d-%m-%Y")
    print(f"=== US Quant Research v2.0 — {today} ===\n")

    # 0. Risk-free rate
    rf = get_risk_free_rate(RISK_FREE_RATE_FALLBACK)

    # 1. Get tickers
    tickers = get_tickers(args.no_scrape, FALLBACK_TICKERS, args.top_n)
    print(f"[1/6] {len(tickers)} tickers loaded")

    if len(tickers) < args.min_tickers:
        print(f"❌ Ticker 數量不足：{len(tickers)}/{args.min_tickers}，中止執行")
        sys.exit(1)

    # 2. Download data
    print(f"[2/6] Downloading price data...")
    price_data = download_price_data(tickers)

    # 3. Compute metrics
    print(f"[3/6] Computing risk metrics...")
    # 【2026-10-20】基準唔喺 most-active 名單時另外下載；原本 SPY 唔喺 price_data → beta 全部 NaN
    # 只用嚟計 beta，唔加入 metrics 名單（universe 不變）
    bench_df = price_data.get(BENCHMARK_TICKER)
    if bench_df is None:
        bench_df = download_price_data([BENCHMARK_TICKER]).get(BENCHMARK_TICKER)
    bench_returns = calc_returns(bench_df["Close"]) if bench_df is not None else pd.Series(dtype=float)
    if bench_returns.empty:
        print(f"  ⚠️ 基準 {BENCHMARK_TICKER} 下載失敗，beta 會留空")

    metrics_rows = []
    for ticker, df in price_data.items():
        close = df["Close"]
        ret = calc_returns(close)
        mdd = calc_max_drawdown(close)
        row = {
            "ticker": ticker,
            "last_price": float(close.iloc[-1]),
            "daily_return": float(ret.iloc[-1]) if not ret.empty else np.nan,
            "week_return": float((1 + ret.tail(5)).prod() - 1) if len(ret) >= 5 else np.nan,
            "month_return": float((1 + ret.tail(22)).prod() - 1) if len(ret) >= 22 else np.nan,
            "cagr": calc_cagr(close),
            "volatility": float(ret.std() * np.sqrt(252)),
            "sharpe": calc_sharpe(ret, rf),
            "sortino": calc_sortino(ret, rf),
            "max_drawdown": mdd,
            "max_dd_duration": calc_max_dd_duration(close),
            "calmar": calc_calmar(ret, mdd),
            "beta": calc_beta(ret, bench_returns),
            "var_95": calc_var(ret, 0.95),
            "parametric_var_95": calc_parametric_var(ret, 0.95),
            "cvar_95": calc_cvar(ret, 0.95),
            "skewness": float(ret.skew()) if not ret.empty else np.nan,
            "kurtosis": float(ret.kurtosis()) if not ret.empty else np.nan,
            "avg_volume": float(df["Volume"].tail(20).mean()) if "Volume" in df else np.nan,
        }
        metrics_rows.append(row)

    metrics_df = pd.DataFrame(metrics_rows)
    metrics_df = metrics_df.sort_values("sharpe", ascending=False)

    # 4. Monte Carlo — Top 20 by Sharpe
    print(f"[4/6] Monte Carlo simulations ({MONTE_CARLO_PATHS:,} paths)...")
    mc_charts = []
    top_chart_tickers = metrics_df.head(20)["ticker"].tolist()
    for ticker in top_chart_tickers:
        if ticker not in price_data:
            continue
        close = price_data[ticker]["Close"]
        mc_df = monte_carlo_gbm(close, MONTE_CARLO_PATHS, 252)
        if mc_df is not None:
            path = generate_fan_chart(ticker, mc_df, CHARTS_DIR, price_label="Price ($)")
            if path:
                mc_charts.append(path)

    # 5. Options / Vol Surface
    print(f"[5/6] Options & Volatility Surface...")
    option_charts = []
    if not args.no_option:
        for ticker in ["SPY", "QQQ", "AAPL", "NVDA", "TSLA"]:
            if ticker not in price_data:
                continue
            opt_df = fetch_option_chain(ticker)
            if opt_df is not None:
                opt_path = os.path.join(RAW_DIR, f"options_{ticker}_{today}.csv")
                opt_df.to_csv(opt_path, index=False)
                vol_path = generate_vol_surface(ticker, opt_df, CHARTS_DIR)
                if vol_path:
                    option_charts.append(vol_path)

    # 6. Save outputs
    print(f"[6/6] Saving outputs...")
    all_charts = mc_charts + option_charts

    report = save_reports(
        today, metrics_df, price_data, tickers, rf,
        MONTE_CARLO_PATHS, all_charts,
        html_report=args.html_report, lookback_days=LOOKBACK_DAYS
    )

    print(f"\n=== 完成 ===")
    print(f"Metrics: {len(metrics_df)} tickers")
    print(f"Charts: {len(all_charts)}")
    print(f"XLSX: {report['xlsx_path']}")
    print(f"Summary: {report['md_path']}")
    if report['html_path']:
        print(f"HTML: {report['html_path']}")

    # ── 自動部署到 ~/hermes reports/ ──
    try:
        from report_deployer import deploy_quant
        deploy_quant(today, str(OUTPUT_DIR), "us-quant", "charts")
        print("✅ 已部署到 ~/hermes reports/")
    except Exception as e:
        print(f"⚠️ 部署失敗（不影響原報告）: {e}")


if __name__ == "__main__":
    main()
