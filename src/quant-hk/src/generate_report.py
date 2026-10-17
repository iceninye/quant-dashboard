"""
HK Quant Research — Report Generation Layer
CSV/XLSX 輸出、Markdown 摘要、HTML 報告
"""

import os
import logging
from datetime import datetime

import numpy as np
import pandas as pd

from config import OUTPUT_DIR, DATA_DIR, REPORTS_DIR, CHARTS_DIR
from core import calc_returns

logger = logging.getLogger("HKQuant.report")


def save_data_files(today: str, metrics_df: pd.DataFrame,
                    price_data: dict) -> pd.DataFrame:
    """儲存 CSV + XLSX 數據檔，回傳 returns_df"""
    # Metrics CSV
    metrics_df.to_csv(os.path.join(DATA_DIR, f"metrics_{today}.csv"), index=False)

    # Returns & Prices
    returns_df = pd.DataFrame({t: calc_returns(d["Close"]) for t, d in price_data.items()})
    if hasattr(returns_df.index, 'tz') and returns_df.index.tz:
        returns_df.index = returns_df.index.tz_localize(None)
    returns_df.to_csv(os.path.join(DATA_DIR, f"returns_{today}.csv"))

    prices_df = pd.DataFrame({t: d["Close"] for t, d in price_data.items()})
    if hasattr(prices_df.index, 'tz') and prices_df.index.tz:
        prices_df.index = prices_df.index.tz_localize(None)
    prices_df.to_csv(os.path.join(DATA_DIR, f"prices_{today}.csv"))

    # Rolling correlation
    if len(returns_df) > 60:
        rolling_corr = returns_df.rolling(60).corr()
        rolling_corr.to_csv(os.path.join(DATA_DIR, f"rolling_corr_{today}.csv"))

    # Static correlation
    corr = returns_df.corr()
    corr.to_csv(os.path.join(DATA_DIR, f"correlation_{today}.csv"))

    # XLSX bundle
    xlsx_path = os.path.join(OUTPUT_DIR, f"all_data_{today}.xlsx")
    with pd.ExcelWriter(xlsx_path, engine="openpyxl") as writer:
        metrics_df.to_excel(writer, sheet_name="Metrics", index=False)
        returns_df.to_excel(writer, sheet_name="Returns")
        prices_df.to_excel(writer, sheet_name="Prices")
        corr.to_excel(writer, sheet_name="Correlation")

    return returns_df


def generate_summary_md(today: str, metrics_df: pd.DataFrame,
                        tickers: list, rf: float, mc_paths: int,
                        all_charts: list, price_data: dict) -> str:
    """生成 Markdown 摘要，回傳檔案路徑"""
    success_rate = len(price_data) / max(len(tickers), 1)

    md_lines = [
        f"# HK Quant Research — {today}", "",
        f"## Summary",
        f"- Tickers: {len(price_data)}/{len(tickers)} ({success_rate:.1%})",
        f"- Risk-Free Rate: {rf:.2%}",
        f"- MC Paths: {mc_paths:,}",
        f"- Charts: {len(all_charts)}", "",
        "## Top 10 by Sharpe", "",
    ]
    for _, r in metrics_df.head(10).iterrows():
        md_lines.append(
            f"- **{r['ticker']}**: Sharpe={r['sharpe']:.2f}, "
            f"CAGR={r['cagr']:.2%}, MDD={r['max_drawdown']:.2%}"
        )
    md_lines.extend([
        "", "## Files",
        f"- `data/metrics_{today}.csv`",
        f"- `all_data_{today}.xlsx`",
        f"- `charts/` ({len(all_charts)} PNG)", ""
    ])

    md_path = os.path.join(OUTPUT_DIR, f"summary_{today}.md")
    with open(md_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(md_lines))

    return md_path


def save_reports(today: str, metrics_df: pd.DataFrame, price_data: dict,
                 tickers: list, rf: float, mc_paths: int,
                 all_charts: list, html_report: bool = False,
                 lookback_days: int = 504) -> dict:
    """
    統一報告入口：儲存數據 + 生成摘要 + 可選 HTML
    回傳 {"xlsx_path", "md_path", "html_path" | None}
    """
    from core import generate_html_report  # 避免循環引入

    logger.info("儲出報告中...")

    # 1. Data files
    save_data_files(today, metrics_df, price_data)

    # 2. Markdown summary
    md_path = generate_summary_md(
        today, metrics_df, tickers, rf, mc_paths, all_charts, price_data
    )

    # 3. HTML (optional)
    html_path = None
    if html_report:
        summary = {
            "date": today,
            "total_tickers": len(tickers),
            "success_count": len(price_data),
            "success_rate": len(price_data) / max(len(tickers), 1),
            "risk_free_rate": rf,
            "mc_paths": mc_paths,
            "mc_horizon": 252,
            "charts_generated": len(all_charts),
        }
        html_path = generate_html_report(
            today, metrics_df, summary, all_charts, REPORTS_DIR,
            market="HK", lookback_days=lookback_days
        )

    xlsx_path = os.path.join(OUTPUT_DIR, f"all_data_{today}.xlsx")

    return {"xlsx_path": xlsx_path, "md_path": md_path, "html_path": html_path}
