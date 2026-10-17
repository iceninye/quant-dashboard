"""
Quant HK — Configuration
統一常數、路徑、設定集中管理
"""

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Tuple


@dataclass
class ProjectConfig:
    output_dir: Path = Path("output")
    market: str = "HK"
    top_n: int = 100
    lookback_days: int = 504          # 2年交易日（統一）
    sim_paths: int = 50000            # 統一 50k 路徑
    sim_steps: int = 252              # 統一 1年
    seed: int = 42
    option_underlier: str = "0700.HK"  # 港股原生代碼
    forecast_horizons: Tuple[int, ...] = (10, 20, 50, 100, 252)
    forecast_quantiles: Tuple[float, ...] = (0.10, 0.25, 0.50, 0.75, 0.90)

    # 市場參數
    risk_free_rate_fallback: float = 0.026  # HIBOR 1M, 2026-05-29
    min_data_points: int = 60
    max_missing_ratio: float = 0.10
    transaction_cost_bps: float = 15.0  # 港股交易成本（印花稅+佣金）


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
    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
}

# ──────────────────────────────────────
# Benchmark
# ──────────────────────────────────────

BENCHMARK_TICKER = "2800.HK"  # 盈富基金（恒指 ETF）

# ──────────────────────────────────────
# Fallback Tickers（恒生指數成份股 + 科技股）
# ──────────────────────────────────────

FALLBACK_TICKERS = [
    "0001.HK", "0002.HK", "0003.HK", "0005.HK", "0006.HK",
    "0011.HK", "0012.HK", "0016.HK", "0017.HK", "0027.HK",
    "0066.HK", "0101.HK", "0175.HK", "0241.HK", "0267.HK",
    "0288.HK", "0291.HK", "0316.HK", "0322.HK", "0386.HK",
    "0388.HK", "0669.HK", "0688.HK", "0700.HK", "0762.HK",
    "0823.HK", "0857.HK", "0868.HK", "0881.HK", "0883.HK",
    "0939.HK", "0941.HK", "0960.HK", "0968.HK", "0981.HK",
    "1038.HK", "1044.HK", "1093.HK", "1109.HK", "1113.HK",
    "1177.HK", "1211.HK", "1299.HK", "1378.HK", "1398.HK",
    "1810.HK", "1876.HK", "1928.HK", "1929.HK", "1997.HK",
    "2007.HK", "2018.HK", "2020.HK", "2269.HK", "2313.HK",
    "2318.HK", "2319.HK", "2331.HK", "2382.HK", "2388.HK",
    "0285.HK", "0772.HK", "0909.HK", "1024.HK", "1347.HK",
    "1833.HK", "2013.HK", "2015.HK", "2518.HK", "3690.HK",
    "6060.HK", "6618.HK", "9618.HK", "9626.HK", "9698.HK",
    "9888.HK", "9961.HK", "0966.HK", "1336.HK", "1339.HK",
    "1359.HK", "1658.HK", "3968.HK", "3988.HK", "0151.HK",
    "0168.HK", "0220.HK", "0680.HK", "1068.HK", "6098.HK",
    "0083.HK", "0270.HK", "0384.HK", "0836.HK", "1088.HK",
    "2688.HK", "1801.HK", "2196.HK", "2252.HK", "2359.HK",
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
