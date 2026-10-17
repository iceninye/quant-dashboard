"""
Quant US — Configuration
統一常數、路徑、設定集中管理
"""

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Tuple


@dataclass
class ProjectConfig:
    output_dir: Path = Path("output")
    market: str = "US"
    top_n: int = 100
    lookback_days: int = 252
    sim_paths: int = 50000
    sim_steps: int = 252
    seed: int = 42
    option_underlier: str = "SPY"
    forecast_horizons: Tuple[int, ...] = (10, 20, 50, 100, 252)
    forecast_quantiles: Tuple[float, ...] = (0.10, 0.25, 0.50, 0.75, 0.90)
    risk_free_rate_fallback: float = 0.04
    min_data_points: int = 60
    max_missing_ratio: float = 0.10
    transaction_cost_bps: float = 5.0  # US 交易成本


CFG = ProjectConfig()

# ──────────────────────────────────────
# 路徑
# ──────────────────────────────────────

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTPUT_DIR = os.path.join(BASE_DIR, "output")
CHARTS_DIR = os.path.join(OUTPUT_DIR, "charts")
DATA_DIR = os.path.join(OUTPUT_DIR, "data")
REPORTS_DIR = os.path.join(OUTPUT_DIR, "reports")
RAW_DIR = os.path.join(OUTPUT_DIR, "raw")

for d in [CHARTS_DIR, DATA_DIR, REPORTS_DIR, RAW_DIR]:
    os.makedirs(d, exist_ok=True)

# ──────────────────────────────────────
# HTTP Headers
# ──────────────────────────────────────

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
}

# ──────────────────────────────────────
# Fallback Tickers
# ──────────────────────────────────────

FALLBACK_TICKERS = [
    "AAPL", "MSFT", "GOOGL", "GOOG", "AMZN", "NVDA", "META", "TSLA", "AVGO", "ORCL",
    "ADBE", "CRM", "AMD", "INTC", "QCOM", "TXN", "MU", "AMAT", "LRCX", "KLAC",
    "SNPS", "CDNS", "MRVL", "NXPI", "MCHP", "ON", "APH", "TEL", "STX", "WDC",
    "BRK-B", "JPM", "V", "MA", "BAC", "WFC", "GS", "MS", "C", "AXP",
    "BLK", "SCHW", "CB", "MMC", "ICE", "CME", "SPGI", "MCO", "FIS", "FISV",
    "UNH", "JNJ", "LLY", "PFE", "ABBV", "MRK", "TMO", "ABT", "DHR", "BMY",
    "AMGN", "GILD", "ISRG", "MDT", "SYK", "BSX", "ZTS", "REGN", "VRTX", "BIIB",
    "WMT", "PG", "KO", "PEP", "COST", "HD", "MCD", "NKE", "SBUX", "TGT",
    "LOW", "TJX", "ORLY", "AZO", "ROST", "DG", "DLTR", "YUM", "CMG", "DPZ",
    "XOM", "CVX", "COP", "EOG", "SLB", "MPC", "PSX", "VLO", "OXY", "HAL",
    "GE", "CAT", "HON", "UPS", "RTX", "LMT", "NOC", "BA", "DE", "MMM",
    "SPY", "QQQ", "IWM", "DIA", "VGT", "XLF", "XLE", "XLV", "XLK", "SMH",
]

# ──────────────────────────────────────
# 風險分級閾值
# ──────────────────────────────────────

RISK_THRESHOLDS = {
    "sharpe_good": 1.0,
    "sharpe_bad": 0.0,
    "mdd_high": -0.20,
    "mdd_medium": -0.10,
    "var_high": -0.03,
}
