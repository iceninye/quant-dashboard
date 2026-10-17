"""
Sentinel Unified v4.0 — Configuration
所有常數、watchlist、路徑集中管理
"""

import os

# ──────────────────────────────────────
# 路徑
# ──────────────────────────────────────

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
REPORT_DIR = os.path.join(BASE_DIR, "reports")
TEMPLATE_DIR = os.path.join(BASE_DIR, "templates")
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(REPORT_DIR, exist_ok=True)

# ──────────────────────────────────────
# Watchlist（Sentinel 完整版）
# ──────────────────────────────────────

WATCHLIST = {
    "港股": [
        "0005.HK", "0388.HK", "0700.HK", "9988.HK", "1810.HK",
        "2318.HK", "0941.HK", "0001.HK", "2382.HK", "1024.HK",
    ],
    "美股": [
        "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA",
        "TSLA", "META", "BRK-B", "JPM", "V", "TSM",
    ],
    "ETF": [
        "2800.HK", "2828.HK", "3067.HK", "SPY", "QQQ",
    ],
    "替代資產": [
        "GC=F", "BTC-USD", "3008.HK", "USDCNH=X",
    ],
}

# 宏觀指標（Financial Risk Monitor 合併）
MACRO_TICKERS = ["^VIX", "^TNX", "DX-Y.NYB", "HG=F", "GC=F"]

ALL_ASSET_TICKERS = []
for tickers in WATCHLIST.values():
    ALL_ASSET_TICKERS.extend(tickers)
ALL_TICKERS = list(set(ALL_ASSET_TICKERS + MACRO_TICKERS))

DISPLAY_NAMES = {
    "0005.HK": "匯豐", "0388.HK": "港交所", "0700.HK": "騰訊",
    "9988.HK": "阿里", "1810.HK": "小米", "2318.HK": "平安",
    "0941.HK": "中移動", "0001.HK": "長和", "2382.HK": "舜宇",
    "1024.HK": "快手",
    "AAPL": "Apple", "MSFT": "Microsoft", "GOOGL": "Google",
    "AMZN": "Amazon", "NVDA": "NVIDIA", "TSLA": "Tesla",
    "META": "Meta", "BRK-B": "Berkshire", "JPM": "JPMorgan",
    "V": "Visa", "TSM": "台積電",
    "2800.HK": "盈富", "2828.HK": "恒H股", "3067.HK": "恒科技",
    "SPY": "S&P 500", "QQQ": "Nasdaq 100",
    "^VIX": "VIX 恐慌指數", "^TNX": "美國10年期債息",
    "DX-Y.NYB": "美元指數 (DXY)", "HG=F": "銅期貨",
    "GC=F": "黃金期貨",
    "BTC-USD": "比特幣", "3008.HK": "BTC ETF",
    "USDCNH=X": "離岸人民幣",
}

SECTOR_MAP = {
    "0005.HK": "金融", "0388.HK": "金融", "0700.HK": "科技",
    "9988.HK": "電商", "1810.HK": "科技", "2318.HK": "金融",
    "0941.HK": "電訊", "0001.HK": "綜合", "2382.HK": "工業",
    "1024.HK": "科技",
    "AAPL": "科技", "MSFT": "科技", "GOOGL": "科技",
    "AMZN": "電商", "NVDA": "半導體", "TSLA": "汽車",
    "META": "科技", "BRK-B": "綜合", "JPM": "金融",
    "V": "金融", "TSM": "半導體",
    "2800.HK": "ETF", "2828.HK": "ETF", "3067.HK": "ETF",
    "SPY": "ETF", "QQQ": "ETF",
    "GC=F": "商品", "BTC-USD": "加密貨幣", "3008.HK": "ETF", "USDCNH=X": "外匯",
}

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
}

RISK_FREE_RATE_FALLBACK = 0.0445  # Updated 2026-05-28 US 10Y yield

# ──────────────────────────────────────
# 風險分級閾值（新增）
# ──────────────────────────────────────

RISK_THRESHOLDS = {
    "vol_q90": None,   # 由 calculate_metrics 動態計算
    "vol_q50": None,
    "mdd_high": -0.20,
    "mdd_medium": -0.10,
    "beta_high": 1.3,
    "beta_low": 0.7,
}

# Fear & Greed 分級
FEAR_GREED_LABELS = {
    (0, 25): "極度恐懼",
    (25, 45): "恐懼",
    (45, 55): "中性",
    (55, 75): "貪婪",
    (75, 100): "極度貪婪",
}
