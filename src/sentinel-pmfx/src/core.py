"""
PMFX — All-in-One Core Module
合併自 config.py + data.py + analytics.py + utils.py + engine.py + generate_report.py
"""

from __future__ import annotations

import glob as _glob
import html as html_mod
import json
import logging
import math
import numpy as np
import os
import pandas as pd
import random
import re
import requests
import sys
import time
import yfinance as yf
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

# 確保可以 import 共用 report_deployer
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))

from dotenv import load_dotenv

# ─── .env 載入 ───
_env_path = Path(__file__).parent.parent / ".env"
if _env_path.exists():
    load_dotenv(_env_path)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 1: CONFIG (原 config.py)
# ═══════════════════════════════════════════════════════════════════════════════

@dataclass
class AppConfig:
    name: str = "hermes_sentinel_pmfx"
    timezone: str = "Asia/Hong_Kong"
    output_dir: Path = Path("reports")
    seed: int = 42

    def __post_init__(self):
        self.output_dir = Path(self.output_dir)

@dataclass
class MarketConfig:
    history_period: str = "2y"
    interval: str = "1d"
    min_history: int = 120
    sim_paths: int = 2500
    sim_steps: int = 300
    atr_window: int = 14
    support_window: int = 20
    corr_window: int = 90

@dataclass
class AlertConfig:
    telegram_enabled: bool = False
    email_enabled: bool = False
    trade_enabled: bool = False
    min_opportunity_score: float = 3.0

@dataclass
class BrokerConfig:
    provider: str = "mock"
    account_id: str = ""
    endpoint: str = ""

@dataclass
class UniverseConfig:
    gold_silver: list = field(default_factory=list)
    fx_major: list = field(default_factory=list)
    fx_cross: list = field(default_factory=list)
    fx_other: list = field(default_factory=list)

@dataclass
class Settings:
    app: AppConfig
    market: MarketConfig
    alerts: AlertConfig
    broker: BrokerConfig
    universe: UniverseConfig
    display_names: dict = field(default_factory=dict)

    @property
    def full_universe(self) -> list[str]:
        seen, out = set(), []
        for lst in [self.universe.gold_silver, self.universe.fx_major,
                    self.universe.fx_cross, self.universe.fx_other]:
            for x in lst:
                if x not in seen:
                    seen.add(x)
                    out.append(x)
        return out

def load_settings(path: str | Path = "configs/config.yaml") -> Settings:
    with open(path, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f)
    if os.getenv("TELEGRAM_BOT_TOKEN"):
        raw["alerts"]["telegram_enabled"] = True
    if os.getenv("SMTP_HOST"):
        raw["alerts"]["email_enabled"] = True
    if os.getenv("BROKER_PROVIDER"):
        raw["broker"]["provider"] = os.getenv("BROKER_PROVIDER")
    if os.getenv("BROKER_ENDPOINT"):
        raw["broker"]["endpoint"] = os.getenv("BROKER_ENDPOINT")
    return Settings(
        app=AppConfig(**raw["app"]),
        market=MarketConfig(**raw["market"]),
        alerts=AlertConfig(**raw["alerts"]),
        broker=BrokerConfig(**raw["broker"]),
        universe=UniverseConfig(**raw["universe"]),
        display_names=raw.get("display_names", {}),
    )

import yaml  # noqa: E402 — used by load_settings above

# ─── 資產分類集合 ───

GOLD_SILVER = {"XAUUSD=X", "SLV", "GC=F", "SI=F", "2840.HK"}
CRYPTO = {"BTC-USD"}
FOREX = {
    "EURUSD=X", "GBPUSD=X", "USDJPY=X", "USDCHF=X",
    "AUDUSD=X", "NZDUSD=X", "USDCAD=X", "DX-Y.NYB",
    "EURJPY=X", "GBPJPY=X", "EURGBP=X", "AUDJPY=X", "CADJPY=X",
}

FALLBACK_NAMES = {
    "XAUUSD=X": "Gold Spot", "XAGUSD=X": "Silver Spot", "SLV": "Silver ETF (SLV)", "GC=F": "Gold Futures (GC)",
    "SI=F": "Silver Futures (SI)", "HG=F": "Copper Futures (HG)", "PL=F": "Platinum Futures (PL)",
    "PA=F": "Palladium Futures (PA)", "CL=F": "Crude Oil (WTI)", "NG=F": "Natural Gas (NG)",
    "ZC=F": "Corn Futures", "ZW=F": "Wheat Futures", "BTC-USD": "Bitcoin (BTC)",
    "DX-Y.NYB": "US Dollar Index (DXY)", "2840.HK": "SPDR Gold (2840.HK)",
    "EURUSD=X": "EUR/USD", "GBPUSD=X": "GBP/USD", "USDJPY=X": "USD/JPY",
    "USDCHF=X": "USD/CHF", "AUDUSD=X": "AUD/USD", "NZDUSD=X": "NZD/USD",
    "USDCAD=X": "USD/CAD", "EURJPY=X": "EUR/JPY", "GBPJPY=X": "GBP/JPY",
    "EURGBP=X": "EUR/GBP", "AUDJPY=X": "AUD/JPY", "CADJPY=X": "CAD/JPY",
}

RR_THRESHOLDS = {
    "min_rr": 1.5,
    "min_net_rr": 1.0,
    "min_opportunity": 3.0,
}

RISK_WEIGHTS = {
    "volatility": 0.3,
    "drawdown": 0.25,
    "sharpe": 0.25,
    "var": 0.2,
}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 2: DATA (原 data.py)
# ═══════════════════════════════════════════════════════════════════════════════

GOLDAPI_URL = "https://api.gold-api.com/price"

def _fetch_goldapi_spot(symbol: str) -> float | None:
    """從 gold-api.com 取即時現貨價（XAU / XAG），免費無需 API key"""
    try:
        resp = requests.get(f"{GOLDAPI_URL}/{symbol}", timeout=10)
        resp.raise_for_status()
        data = resp.json()
        price = data.get("price")
        return float(price) if price else None
    except Exception as e:
        print(f"  ⚠️ gold-api.com error({symbol}): {e}")
        return None

TWELVEDATA_TICKERS = {"XAUUSD=X": "XAU/USD"}

def _get_twelvedata_key() -> str | None:
    return os.getenv("TWELVEDATA_API_KEY")

def _download_twelvedata(ticker: str, period: str, interval: str) -> pd.DataFrame:
    """用 Twelve Data API 取數據（專為 XAU/USD 等現貨對）"""
    key = _get_twelvedata_key()
    if not key:
        print(f"  ⚠️ TWELVEDATA_API_KEY 未設定，無法取得 {ticker}")
        return pd.DataFrame()

    td_symbol = TWELVEDATA_TICKERS.get(ticker, ticker)
    outputsize = {"1y": 250, "2y": 500, "6mo": 125}.get(period, 500)
    td_interval = {"1d": "1day", "1wk": "1week", "1mo": "1month"}.get(interval, "1day")

    url = "https://api.twelvedata.com/time_series"
    params = {"symbol": td_symbol, "interval": td_interval, "outputsize": outputsize, "apikey": key}
    try:
        resp = requests.get(url, params=params, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        if "values" not in data:
            print(f"  ⚠️ Twelve Data 無數據: {data.get('message', 'unknown')}")
            return pd.DataFrame()
        df = pd.DataFrame(data["values"])
        df = df.rename(columns={"datetime": "Date"})
        df["Date"] = pd.to_datetime(df["Date"])
        for col in ["open", "high", "low", "close"]:
            if col in df.columns:
                df[col.capitalize()] = pd.to_numeric(df[col], errors="coerce")
        df["Volume"] = pd.to_numeric(df.get("volume", 0), errors="coerce")
        df = df.sort_values("Date").reset_index(drop=True)
        return df
    except Exception as e:
        print(f"  ⚠️ Twelve Data error({ticker}): {e}")
        return pd.DataFrame()

def download_history(ticker: str, period: str, interval: str) -> pd.DataFrame:
    """統一入口：XAUUSD=X 走 Twelve Data，其餘走 yfinance"""
    if ticker in TWELVEDATA_TICKERS:
        return _download_twelvedata(ticker, period, interval)
    try:
        df = yf.download(
            ticker, period=period, interval=interval,
            auto_adjust=False, progress=False, threads=False
        )
        if df is None or df.empty:
            return pd.DataFrame()
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = [c[0] for c in df.columns]
        df = df.reset_index()
        if "Date" not in df.columns:
            first_col = df.columns[0]
            df = df.rename(columns={first_col: "Date"})
        if "Datetime" in df.columns and "Date" not in df.columns:
            df = df.rename(columns={"Datetime": "Date"})
        df["Date"] = pd.to_datetime(df["Date"], errors="coerce")
        df = df.dropna(subset=["Date"]).sort_values("Date").reset_index(drop=True)
        return df
    except Exception as e:
        print(f"  ⚠️ download_history({ticker}): {e}")
        return pd.DataFrame()

def normalize_close(df: pd.DataFrame) -> pd.Series | None:
    if df.empty:
        return None
    col = next((c for c in ["Adj Close", "Close"] if c in df.columns), None)
    if col is None:
        return None
    s = df[col].astype(float).dropna()
    # 【Fix 2b】幫 benchmark 補 DatetimeIndex（beta/alpha 嘅 index intersection 需要）
    if "Date" in df.columns and len(s) == len(df):
        try:
            s = pd.Series(s.to_numpy(), index=pd.to_datetime(df["Date"], errors="coerce")).dropna()
        except Exception:
            pass
    return s if len(s) > 0 else None

def save_df(df: pd.DataFrame, path: str | Path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(path, index=False)


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 3: ANALYTICS (原 analytics.py)
# ═══════════════════════════════════════════════════════════════════════════════

# ─── 技術指標 ───

def atr(hist: pd.DataFrame, period: int = 14) -> float:
    """Average True Range"""
    try:
        h = hist["High"].astype(float)
        l = hist["Low"].astype(float)
        c = hist["Close"].astype(float)
        tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)
        return float(tr.rolling(period).mean().iloc[-1])
    except Exception:
        return np.nan

def rsi(close: pd.Series, period: int = 14) -> float:
    """Relative Strength Index"""
    try:
        delta = close.diff()
        gain = delta.where(delta > 0, 0.0).rolling(period).mean()
        loss = (-delta.where(delta < 0, 0.0)).rolling(period).mean()
        rs = gain / loss.replace(0, np.nan)
        return float(100 - 100 / (1 + rs.iloc[-1]))
    except Exception:
        return 50.0

def support_resistance(close: pd.Series, window: int = 20) -> tuple:
    """Simple pivot-based S/R"""
    try:
        highs = close.rolling(window).max()
        lows = close.rolling(window).min()
        return float(lows.iloc[-1]), float(highs.iloc[-1])
    except Exception:
        return np.nan, np.nan

# ─── 策略信號 ───

def trend_following(close: pd.Series) -> dict:
    """EMA crossover trend signal"""
    try:
        ema20 = close.ewm(span=20).mean()
        ema50 = close.ewm(span=50).mean()
        last = float(close.iloc[-1])
        if ema20.iloc[-1] > ema50.iloc[-1] and last > ema20.iloc[-1]:
            return {"signal": 1, "score": 0.8, "reason": "EMA20>EMA50, price>EMA20"}
        elif ema20.iloc[-1] < ema50.iloc[-1] and last < ema20.iloc[-1]:
            return {"signal": -1, "score": 0.8, "reason": "EMA20<EMA50, price<EMA20"}
        return {"signal": 0, "score": 0.3, "reason": "neutral"}
    except Exception:
        return {"signal": 0, "score": 0, "reason": "error"}

def mean_reversion(close: pd.Series) -> dict:
    """Bollinger Band mean reversion"""
    try:
        ma = close.rolling(20).mean()
        std = close.rolling(20).std()
        upper = ma + 2 * std
        lower = ma - 2 * std
        last = float(close.iloc[-1])
        if last < float(lower.iloc[-1]):
            return {"signal": 1, "score": 0.7, "reason": "below lower BB"}
        elif last > float(upper.iloc[-1]):
            return {"signal": -1, "score": 0.7, "reason": "above upper BB"}
        return {"signal": 0, "score": 0.3, "reason": "within BB"}
    except Exception:
        return {"signal": 0, "score": 0, "reason": "error"}

def breakout(close: pd.Series, window: int = 20) -> dict:
    """Donchian breakout"""
    try:
        high = float(close.rolling(window).max().iloc[-1])
        low = float(close.rolling(window).min().iloc[-1])
        last = float(close.iloc[-1])
        if last >= high * 0.99:
            return {"signal": 1, "score": 0.75, "reason": "near 20d high"}
        elif last <= low * 1.01:
            return {"signal": -1, "score": 0.75, "reason": "near 20d low"}
        return {"signal": 0, "score": 0.3, "reason": "mid-range"}
    except Exception:
        return {"signal": 0, "score": 0, "reason": "error"}

def intraday_swing(hist: pd.DataFrame) -> dict:
    """Simple price momentum"""
    try:
        close = hist["Close"].astype(float)
        ret5 = close.pct_change(5).iloc[-1]
        if ret5 > 0.02:
            return {"signal": 1, "score": 0.6, "reason": f"5d return +{ret5:.1%}"}
        elif ret5 < -0.02:
            return {"signal": -1, "score": 0.6, "reason": f"5d return {ret5:.1%}"}
        return {"signal": 0, "score": 0.3, "reason": "flat"}
    except Exception:
        return {"signal": 0, "score": 0, "reason": "error"}

# ─── Monte Carlo ───

def monte_carlo_gbm(close: pd.Series, n_paths: int = 2500, n_steps: int = 300, seed: int = 42) -> np.ndarray:
    """GBM Monte Carlo simulation"""
    np.random.seed(seed)
    log_ret = np.log(close / close.shift(1)).dropna()
    mu = float(log_ret.mean())
    sigma = float(log_ret.std())
    s0 = float(close.iloc[-1])
    dt = 1.0
    z = np.random.standard_normal((n_paths, n_steps))
    paths = np.zeros((n_paths, n_steps + 1))
    paths[:, 0] = s0
    for t in range(n_steps):
        paths[:, t + 1] = paths[:, t] * np.exp((mu - 0.5 * sigma**2) * dt + sigma * np.sqrt(dt) * z[:, t])
    return paths

def percentile_table(paths: np.ndarray, days: list) -> pd.DataFrame:
    """Percentile table from Monte Carlo paths"""
    rows = []
    for d in days:
        if d < paths.shape[1]:
            vals = paths[:, d]
            rows.append({
                "day": d,
                "p10": np.percentile(vals, 10),
                "p25": np.percentile(vals, 25),
                "p50": np.percentile(vals, 50),
                "p75": np.percentile(vals, 75),
                "p90": np.percentile(vals, 90),
            })
    return pd.DataFrame(rows)

# ─── 風險指標 ───

def metrics(close: pd.Series, benchmark: pd.Series | None = None,
            risk_free_rate: float = 0.0) -> dict:
    """Calculate risk metrics for a price series"""
    try:
        if len(close) < 30:
            return {}
        ret = close.pct_change().dropna()
        ann = 252
        # 【Fix 2】index 唔一定係日期；RangeIndex 相減會得 int，冇 .days
        if isinstance(close.index, pd.DatetimeIndex) and len(close) > 1:
            n_days = max(int((close.index[-1] - close.index[0]).days), 1)
        else:
            # fallback：交易日 → 日曆日（252 交易日 ≈ 365 日）
            n_days = max(int(round((len(close) - 1) * 365.0 / 252.0)), 1)
        total_ret = float(close.iloc[-1] / close.iloc[0] - 1)
        ann_ret = float((1 + total_ret) ** (365.0 / n_days) - 1) if n_days > 0 else 0.0
        ann_vol = float(ret.std() * np.sqrt(ann))
        sharpe = (ann_ret - risk_free_rate) / ann_vol if ann_vol > 0 else 0.0
        cummax = close.cummax()
        dd = (close - cummax) / cummax
        max_dd = float(dd.min())
        calmar = ann_ret / abs(max_dd) if max_dd != 0 else 0.0
        daily_rf = risk_free_rate / ann
        excess = ret - daily_rf
        downside = excess[excess < 0]
        down_vol = float(downside.std() * np.sqrt(ann)) if len(downside) > 0 else 1e-12
        sortino = (excess.mean() * ann) / down_vol if down_vol > 0 else 0.0
        beta = alpha = np.nan
        if benchmark is not None and len(benchmark) > 30:
            b_ret = benchmark.pct_change().dropna()
            common = ret.index.intersection(b_ret.index)
            if len(common) > 30:
                cov = np.cov(ret.loc[common], b_ret.loc[common])
                beta = float(cov[0, 1] / cov[1, 1]) if cov[1, 1] != 0 else np.nan
                b_ann = float((1 + b_ret.loc[common].sum()) ** (ann / len(common)) - 1)
                alpha = ann_ret - beta * b_ann if not np.isnan(beta) else np.nan
        var_95 = float(ret.quantile(0.05))
        cvar_95 = float(ret[ret <= var_95].mean()) if len(ret[ret <= var_95]) > 0 else var_95
        return {
            "total_return": round(total_ret, 4),
            "ann_return": round(ann_ret, 4),
            "ann_volatility": round(ann_vol, 4),
            "sharpe": round(sharpe, 3),
            "max_drawdown": round(max_dd, 4),
            "calmar": round(calmar, 3),
            "sortino": round(sortino, 3),
            "beta": round(beta, 3) if not np.isnan(beta) else np.nan,
            "alpha": round(alpha, 4) if not np.isnan(alpha) else np.nan,
            "var_95": round(var_95, 4),
            "cvar_95": round(cvar_95, 4),
            "skew": round(float(ret.skew()), 3),
            "kurtosis": round(float(ret.kurtosis()), 3),
        }
    except Exception as e:
        return {"error": str(e)}

def risk_parity_weights(returns_df: pd.DataFrame) -> pd.Series:
    """Inverse volatility weighting"""
    try:
        vols = returns_df.std()
        inv_vol = 1.0 / vols.replace(0, np.nan)
        weights = inv_vol / inv_vol.sum()
        return weights.fillna(0)
    except Exception:
        return pd.Series(dtype=float)

# ─── 跨資產分析 ───

def gold_silver_ratio(gold: pd.Series, silver: pd.Series) -> pd.DataFrame:
    """Gold/Silver ratio time series"""
    common = gold.index.intersection(silver.index)
    ratio = gold.loc[common] / silver.loc[common].replace(0, np.nan)
    return pd.DataFrame({"date": common, "ratio": ratio.values})

def fx_strength_matrix(prices: pd.DataFrame) -> pd.DataFrame:
    """Simple FX correlation matrix from price data"""
    try:
        pivot = prices.pivot_table(index="Date", columns="ticker", values="Close")
        ret = pivot.pct_change().dropna()
        return ret.corr()
    except Exception:
        return pd.DataFrame()

def dollar_index_correlation(prices: pd.DataFrame, dxy: pd.Series) -> pd.DataFrame:
    """Correlation of each ticker with DXY"""
    try:
        pivot = prices.pivot_table(index="Date", columns="ticker", values="Close")
        ret = pivot.pct_change().dropna()
        dxy_ret = dxy.pct_change().dropna()
        common = ret.index.intersection(dxy_ret.index)
        corr = ret.loc[common].corrwith(dxy_ret.loc[common])
        return corr.dropna().sort_values(ascending=False).reset_index()
    except Exception:
        return pd.DataFrame()

def cross_asset_summary(prices: pd.DataFrame) -> dict:
    """Cross-asset summary"""
    result = {}
    try:
        if prices.empty:
            return result
        pivot = prices.pivot_table(index="Date", columns="ticker", values="Close")
        ret = pivot.pct_change().dropna()
        gold_col = "XAUUSD=X"
        silver_col = "SI=F"
        if gold_col in pivot.columns and silver_col in pivot.columns:
            gsr = pivot[gold_col] / pivot[silver_col].replace(0, np.nan)
            result["gold_silver_ratio"] = {
                "current": float(gsr.iloc[-1]),
                "avg_1y": float(gsr.mean()),
                "signal": "偏高" if gsr.iloc[-1] > gsr.mean() * 1.1 else "偏低" if gsr.iloc[-1] < gsr.mean() * 0.9 else "正常",
            }
        corr = ret.corr()
        result["avg_correlation"] = float(corr.values[np.triu_indices_from(corr.values, 1)].mean())
    except Exception:
        pass
    return result

# ─── 組合管理 ───

def build_risk_budget(df: pd.DataFrame) -> pd.DataFrame:
    """Build risk budget allocation from signal DataFrame"""
    try:
        if df.empty or "ticker" not in df.columns:
            return pd.DataFrame()
        active = df[df["action"].isin(["買", "沽"])].copy()
        if active.empty:
            return pd.DataFrame()
        vol = active["ann_volatility"].replace(0, np.nan)
        inv_vol = 1.0 / vol
        weights = inv_vol / inv_vol.sum()
        active = active.copy()
        active["weight"] = weights.values
        active["risk_budget"] = active["weight"] * active["ann_volatility"]
        return active[["ticker", "action", "weight", "risk_budget", "opportunity_score"]]
    except Exception:
        return pd.DataFrame()

def calculate_net_rr_ev(entry: float, target: float, stop: float, action: str, win_rate: float,
                        commission_rate: float = 0.0005, slippage_rate: float = 0.001) -> tuple:
    """計算包含真實市場摩擦成本的淨風報比 (Net RR) 與淨期望值 (Net EV)"""
    _long_kw = {'買', 'BUY', 'Long', 'buy', 'long'}
    is_long = action in _long_kw
    if is_long:
        actual_entry  = entry  * (1 + slippage_rate)
        actual_target = target * (1 - slippage_rate)
        actual_stop   = stop   * (1 - slippage_rate)
    else:
        actual_entry  = entry  * (1 - slippage_rate)
        actual_target = target * (1 + slippage_rate)
        actual_stop   = stop   * (1 + slippage_rate)
    commission_cost = actual_entry * commission_rate * 2
    net_profit = abs(actual_target - actual_entry) - commission_cost
    net_risk   = abs(actual_entry - actual_stop) + commission_cost
    net_rr = net_profit / net_risk if net_risk > 0 else 0.0
    win_prob = win_rate / 100.0
    net_ev   = (win_prob * net_profit) - ((1 - win_prob) * net_risk)
    return net_rr, net_ev

def compute_portfolio_stats(df: pd.DataFrame) -> dict:
    """Compute portfolio-level stats（剔除 rr_valid == False 的 INVALID 信號）"""
    try:
        if df.empty:
            return {}
        if 'rr_valid' in df.columns:
            active = df[(df["action"].isin(["買", "沽"])) & (df["rr_valid"] == True)]
        else:
            active = df[df["action"].isin(["買", "沽"])]
        if active.empty:
            return {}
        return {
            "avg_win_rate": float(active["success_rate"].mean()),
            "avg_rr": float(active["reward_risk"].mean()),
            "avg_ev": float(active["expected_value"].mean()),
            "count": len(active),
            "invalid_count": int(df[(df["action"].isin(["買", "沽"])) & (df.get("rr_valid", True) == False)].shape[0]) if 'rr_valid' in df.columns else 0,
        }
    except Exception:
        return {}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 4: UTILS (原 utils.py)
# ═══════════════════════════════════════════════════════════════════════════════

@dataclass
class OrderIntent:
    ticker: str
    action: str  # "買" or "沽"
    qty: int
    entry: float
    stop: float
    target: float

class Broker(Protocol):
    def place_order(self, intent: OrderIntent) -> dict: ...

class PaperBroker:
    """Paper trading broker — logs but does not execute"""
    def __init__(self, endpoint: str = "", account_id: str = ""):
        self.endpoint = endpoint
        self.account_id = account_id

    def place_order(self, intent: OrderIntent) -> dict:
        print(f"  📝 PAPER ORDER: {intent.action} {intent.qty}x {intent.ticker} @ {intent.entry}")
        return {"status": "paper", "ticker": intent.ticker, "action": intent.action}

def get_broker(provider: str = "paper", endpoint: str = "", account_id: str = "") -> Broker:
    if provider == "paper":
        return PaperBroker(endpoint, account_id)
    raise ValueError(f"Unknown broker provider: {provider}")

def build_alert_text(today: str, df: pd.DataFrame, min_score: float) -> str:
    """Build alert text for high-opportunity signals"""
    if df.empty:
        return f"📊 Hermes Sentinel PMFX {today} — 無交易信號"
    top = df[df["opportunity_score"] >= min_score].head(5)
    if top.empty:
        max_score = df["opportunity_score"].max()
        return f"📊 Hermes Sentinel PMFX {today} — 無高分信號（最高 {max_score:.1f}）"
    lines = [f"📊 Hermes Sentinel PMFX {today}", f"高機會信號（≥{min_score}）："]
    for _, r in top.iterrows():
        lines.append(f"  {r['action']} {r['ticker']} | 入場 {r['entry_price']:.4f} | 目標 {r['target_price']:.4f} | 勝率 {r['success_rate']:.0%}")
    return "\n".join(lines)

def send_telegram(text: str):
    """Stub — integrate with Hermes send_message if needed"""
    print(f"  📱 Telegram alert: {text[:80]}...")

def send_email(subject: str, text: str):
    """Stub — integrate with email if needed"""
    print(f"  📧 Email alert: {subject}")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 5: REPORTS (原 generate_report.py)
# ═══════════════════════════════════════════════════════════════════════════════

def classify_ticker(ticker: str) -> str:
    """根據 ticker 判斷資產類別"""
    if ticker in GOLD_SILVER:
        return "Gold & Silver"
    if ticker in CRYPTO:
        return "Crypto"
    if ticker in FOREX:
        return "Forex"
    return "Commodities"

def format_price(val: float, ticker: str) -> str:
    """根據資產類別決定小數位"""
    if ticker in FOREX and "JPY" not in ticker:
        return f"{val:.4f}"
    if "JPY" in ticker:
        return f"{val:.2f}"
    if val >= 1000:
        return f"{val:.2f}"
    return f"{val:.4f}"

def build_markdown(today: str, df: pd.DataFrame, failures: list,
                   portfolio: dict, cross: dict) -> str:
    """生成 Markdown 摘要報告"""
    lines = [
        f"# Hermes Sentinel PMFX — {today}",
        "",
        "## 概覽",
        f"- 分析標的：{len(df)}",
        f"- 失敗：{len(failures)}",
        f"- 買入訊號：{(df['action']=='買').sum() if not df.empty else 0}",
        f"- 沽出訊號：{(df['action']=='沽').sum() if not df.empty else 0}",
        f"- 觀望：{(df['action']=='觀望').sum() if not df.empty else 0}",
        "",
    ]
    if cross.get("gold_silver_ratio"):
        r = cross["gold_silver_ratio"]
        lines += [
            "## 金銀比",
            f"- 現值：{r['current']:.2f}",
            f"- 1年均值：{r['avg_1y']:.2f}",
            f"- 解讀：{r['signal']}",
            "",
        ]
    if not df.empty:
        lines += [
            "## 交易建議（Top 40）",
            "|#|Ticker|Name|Action|Entry|Target|Stop|Win%|RR|Net RR|EV|Net EV|Score|Status|",
            "|--:|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
        ]
        for _, r in df.head(40).iterrows():
            _rr_valid = r.get('rr_valid', True)
            _net_valid = r.get('net_rr_valid', True)
            if not _rr_valid:
                status = "❌INVALID"
            elif not _net_valid:
                status = "⚠️NET<0.5"
            else:
                status = "✅"
            lines.append(
                f"|{r.get('rank','')}|{r['ticker']}|{r.get('name','')}|{r['action']}"
                f"|{r.get('entry_price',0):.6f}|{r.get('target_price',0):.6f}"
                f"|{r.get('stop_loss',0):.6f}|{r.get('success_rate',0):.0%}"
                f"|{r.get('reward_risk',0):.2f}|{r.get('net_rr',0):.2f}"
                f"|{r.get('expected_value',0):.6f}|{r.get('net_ev',0):.6f}"
                f"|{r.get('opportunity_score',0):.1f}|{status}|"
            )
        lines.append("")
    if portfolio:
        _inv = portfolio.get('invalid_count', 0)
        lines += [
            "## 組合統計（已剔除異常值）",
            f"- 平均勝率：{portfolio.get('avg_win_rate', 0):.1%}",
            f"- 平均風回比（原始）：{portfolio.get('avg_rr', 0):.2f}",
            f"- 平均期望值：{portfolio.get('avg_ev', 0):.6f}",
            f"- 有效信號數：{portfolio.get('count', 0)}",
        ] + ([f"- ⚠️ 已剔除 {_inv} 個無效信號（RR Clamp 或 Net RR<0.5）"] if _inv > 0 else []) + [""]
    lines += [
        "---",
        "⚠️ 以上僅供量化研究，不構成投資建議，投資需自行承擔風險。",
    ]
    return "\n".join(lines)

def build_html(today: str, df: pd.DataFrame, settings: Any,
               cross: dict = None) -> str:
    """純 HTML+CSS 儀表板，零 JavaScript，零 CDN 依賴"""

    # ─── 準備數據 ───
    rows = []
    for _, r in df.iterrows():
        ticker = r['ticker']
        display = settings.display_names.get(ticker, FALLBACK_NAMES.get(ticker, ticker))
        score = float(r.get('opportunity_score', 0))
        action = r.get('action', '觀望')
        price = r.get('last_price', 0)
        entry = r.get('entry_price', 0)
        sl = r.get('stop_loss', 0)
        tp = r.get('target_price', 0)
        rr = r.get('reward_risk', 0)
        rr_valid = r.get('rr_valid', True)
        conf = r.get('confidence', 0)
        regime = r.get('market_regime', '')
        cat = classify_ticker(ticker)
        rows.append({
            'ticker': ticker, 'display': display, 'category': cat,
            'score': score, 'action': action, 'price': price,
            'entry': entry, 'sl': sl, 'tp': tp, 'rr': rr,
            'conf': conf, 'regime': regime, 'rr_valid': rr_valid,
            'net_rr': r.get('net_rr', float('nan')), 'net_rr_valid': r.get('net_rr_valid', True),
        })

    strong = [r for r in rows if r['score'] >= 4.0]
    strong.sort(key=lambda x: x['score'], reverse=True)
    buy_signals = [r for r in strong if r['action'] in ('買', '買入')]
    sell_signals = [r for r in strong if r['action'] in ('沽', '賣出')]

    # ─── 相關性警告 ───
    warnings = []
    if cross:
        for key, info in cross.items():
            if isinstance(info, dict) and info.get('warning', False):
                warnings.append("⚠️ {}: 相關性 {:.2f}".format(key, info['correlation']))
            elif isinstance(info, dict) and info.get('signal'):
                warnings.append("⚠️ {}: {}".format(key, info['signal']))

    def esc(t):
        return html_mod.escape(str(t)) if t else '-'

    def fmt(v, d=2):
        if isinstance(v, (int, float)) and v == v:
            return "{:.{}f}".format(v, d)
        return '-'

    def sig_color(action):
        if action in ('買', '買入'): return '#27ae60'
        if action in ('沽', '賣出'): return '#e74c3c'
        if action == 'Pending': return '#9b59b6'
        return '#95a5a6'

    def score_bg(s):
        if s >= 5.0: return '#c0392b'
        if s >= 4.0: return '#e67e22'
        if s >= 3.0: return '#f39c12'
        return '#27ae60'

    def pos_size(s):
        return '2%' if s > 5.0 else ('1%' if s >= 4.0 else '-')

    def table_rows(signals):
        if not signals:
            return '<tr><td colspan="9" style="text-align:center;color:#999;padding:12px;">無信號</td></tr>'
        out = ''
        for s in signals:
            inv_tag = ''
            if not s.get('rr_valid', True):
                inv_tag = ' <span style="background:#c0392b;color:#fff;padding:1px 6px;border-radius:3px;font-size:10px;">INVALID</span>'
            elif not s.get('net_rr_valid', True):
                inv_tag = ' <span style="background:#e67e22;color:#fff;padding:1px 6px;border-radius:3px;font-size:10px;">NET&lt;0.5</span>'
            out += '<tr>'
            out += '<td style="padding:6px 8px;border-bottom:1px solid #eee;">' + esc(s['display']) + inv_tag + '</td>'
            out += '<td style="padding:6px 8px;border-bottom:1px solid #eee;">' + esc(s['category']) + '</td>'
            out += '<td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:center;">'
            out += '<span style="background:' + sig_color(s['action']) + ';color:#fff;padding:2px 8px;border-radius:4px;font-size:12px;">' + esc(s['action']) + '</span></td>'
            out += '<td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:center;">'
            out += '<span style="background:' + score_bg(s['score']) + ';color:#fff;padding:2px 8px;border-radius:4px;font-weight:bold;">' + "{:.1f}".format(s['score']) + '</span></td>'
            out += '<td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;">' + fmt(s['price']) + '</td>'
            out += '<td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;">' + fmt(s['entry']) + ' / ' + fmt(s['sl']) + ' / ' + fmt(s['tp']) + '</td>'
            out += '<td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:center;">' + fmt(s['rr']) + '</td>'
            _net = s.get('net_rr')
            _net_str = "{:.2f}".format(_net) if _net and _net == _net else '-'
            out += '<td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:center;">' + _net_str + '</td>'
            out += '<td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:center;">' + pos_size(s['score']) + '</td>'
            out += '</tr>\n'
        return out

    # 相關性警告 HTML
    warn_html = ''
    if warnings:
        items = ''.join('<li style="margin:4px 0;">' + w + '</li>' for w in warnings)
        warn_html = (
            '<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:6px;padding:12px 16px;margin-bottom:16px;">'
            '<strong style="color:#856404;">⚠️ 相關性警告</strong>'
            '<ul style="margin:8px 0 0 0;padding-left:20px;color:#856404;">' + items + '</ul></div>'
        )

    # ─── KPI 數據 ───
    total = len(df)
    _cache_flag = False

    if 'success_rate' in df.columns and 'rr_valid' in df.columns:
        _valid_active = df[(df['action'].isin(['買', '沽'])) & (df['rr_valid'] == True)]
        if not _valid_active.empty:
            win_rate = float(_valid_active['success_rate'].mean()) * 100
        else:
            win_rate = 0.0
    elif 'success_rate' in df.columns:
        _active = df[df['action'].isin(['買', '沽'])]
        win_rate = float(_active['success_rate'].mean()) * 100 if not _active.empty else 0.0
    else:
        win_rate = 0.0

    if 'reward_risk' in df.columns and 'rr_valid' in df.columns:
        _valid_rr = df[(df['action'].isin(['買', '沽'])) & (df['rr_valid'] == True)]
        avg_rr = float(_valid_rr['reward_risk'].mean()) if not _valid_rr.empty else 0.0
    elif 'reward_risk' in df.columns:
        _active_rr = df[df['action'].isin(['買', '沽'])]
        avg_rr = float(_active_rr['reward_risk'].mean()) if not _active_rr.empty else 0.0
    else:
        avg_rr = 0.0

    _invalid_count = int(df[(df['action'].isin(['買', '沽'])) & (df['rr_valid'] == False)].shape[0]) if 'rr_valid' in df.columns else 0

    # 第二層：若實時計算為 0，從最新 JSON report 快取讀取
    if win_rate == 0.0 or avg_rr == 0.0:
        try:
            _json_files = sorted(_glob.glob(str(Path(settings.app.output_dir) / "*/reports/report_*.json")), reverse=True)
            for _jf in _json_files:
                if _jf.endswith(f"report_{today}.json"):
                    continue
                with open(_jf, 'r') as _f:
                    _cache = json.load(_f)
                _port = _cache.get('portfolio', {})
                if _port.get('avg_win_rate', 0) > 0:
                    if win_rate == 0.0:
                        win_rate = _port['avg_win_rate'] * 100
                    if avg_rr == 0.0:
                        avg_rr = _port.get('avg_rr', 0)
                    _cache_flag = True
                    logger.info("使用快取勝率數據: %.1f%% (from %s)", win_rate, _jf)
                    break
        except Exception as e:
            logger.warning("快取讀取失敗: %s", e)

    _cache_mark = '*' if _cache_flag else ''

    # 全部信號表格（score >= 3.0）
    all_rows = [r for r in rows if r['score'] >= 3.0]
    all_rows.sort(key=lambda x: x['score'], reverse=True)

    # ─── 組裝 HTML ───
    html = '<!DOCTYPE html>\n<html lang="zh-Hant">\n<head>\n'
    html += '<meta charset="UTF-8">\n'
    html += '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
    html += '<title>Hermes Sentinel PMFX — ' + esc(today) + '</title>\n'
    html += '''<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f0f2f5;color:#333;line-height:1.6;padding:16px}
.container{max-width:1000px;margin:0 auto}
h1{font-size:20px;margin-bottom:4px}
.subtitle{color:#666;font-size:13px;margin-bottom:16px}
.kpi-row{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px}
.kpi{flex:1;min-width:120px;background:#fff;border-radius:8px;padding:12px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.kpi-value{font-size:22px;font-weight:bold;color:#2c3e50}
.kpi-label{font-size:11px;color:#888;margin-top:2px}
.section{background:#fff;border-radius:8px;padding:16px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.section h2{font-size:15px;color:#2c3e50;margin-bottom:10px;border-bottom:2px solid #3498db;padding-bottom:6px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{background:#f8f9fa;padding:8px;text-align:left;font-weight:600;border-bottom:2px solid #dee2e6;white-space:nowrap}
.footer{text-align:center;color:#999;font-size:11px;margin-top:16px}
</style>
</head>
<body>
<div class="container">
'''
    html += '<h1>📊 Hermes Sentinel PMFX</h1>\n'
    html += '<p class="subtitle">' + esc(today) + '｜多重時間框架 + 動量 + 市場機制分析</p>\n'

    # KPI cards
    html += '<div class="kpi-row">\n'
    html += '<div class="kpi"><div class="kpi-value">' + str(total) + '</div><div class="kpi-label">分析標的</div></div>\n'
    html += '<div class="kpi"><div class="kpi-value">' + str(len(buy_signals)) + '</div><div class="kpi-label">強力買入</div></div>\n'
    html += '<div class="kpi"><div class="kpi-value">' + str(len(sell_signals)) + '</div><div class="kpi-label">強力賣出</div></div>\n'
    html += '<div class="kpi"><div class="kpi-value">' + "{:.1f}".format(win_rate) + '%' + _cache_mark + '</div><div class="kpi-label">勝率' + (' (快取)' if _cache_flag else '') + '</div></div>\n'
    html += '<div class="kpi"><div class="kpi-value">' + "{:.2f}".format(avg_rr) + _cache_mark + '</div><div class="kpi-label">平均風報比' + (' (已剔除{}無效)'.format(_invalid_count) if _invalid_count > 0 else '') + '</div></div>\n'
    # Net RR KPI
    if 'net_rr' in df.columns and 'net_rr_valid' in df.columns:
        _valid_net = df[(df['action'].isin(['買', '沽'])) & (df['net_rr_valid'] == True)]
        _avg_net_rr = float(_valid_net['net_rr'].mean()) if not _valid_net.empty else 0.0
        _net_invalid = int(df[(df['action'].isin(['買', '沽'])) & (df['net_rr_valid'] == False)].shape[0])
    else:
        _avg_net_rr = 0.0
        _net_invalid = 0
    html += '<div class="kpi"><div class="kpi-value">' + "{:.2f}".format(_avg_net_rr) + '</div><div class="kpi-label">淨風報比（含費用）' + (' ⚠️{}無效'.format(_net_invalid) if _net_invalid > 0 else '') + '</div></div>\n'
    html += '</div>\n\n'

    html += warn_html + '\n'

    # Buy signals
    html += '<div class="section">\n'
    html += '<h2>🔴 強力買入信號（Score ≥ 4.0）</h2>\n'
    html += '<table>\n<tr><th>標的</th><th>類別</th><th>方向</th><th>評分</th><th>現價</th><th>入場/止損/目標</th><th>風報比</th><th>淨風報比</th><th>倉位</th></tr>\n'
    html += table_rows(buy_signals)
    html += '</table>\n</div>\n\n'

    # Sell signals
    html += '<div class="section">\n'
    html += '<h2>🟢 強力賣出信號（Score ≥ 4.0）</h2>\n'
    html += '<table>\n<tr><th>標的</th><th>類別</th><th>方向</th><th>評分</th><th>現價</th><th>入場/止損/目標</th><th>風報比</th><th>淨風報比</th><th>倉位</th></tr>\n'
    html += table_rows(sell_signals)
    html += '</table>\n</div>\n\n'

    # All signals
    html += '<div class="section">\n'
    html += '<h2>📋 全部信號（Score ≥ 3.0）</h2>\n'
    html += '<table>\n<tr><th>標的</th><th>類別</th><th>方向</th><th>評分</th><th>現價</th><th>入場/止損/目標</th><th>風報比</th><th>淨風報比</th><th>倉位</th></tr>\n'
    html += table_rows(all_rows)
    html += '</table>\n</div>\n\n'

    # Pending Data section
    pending_rows_list = [r for r in rows if r['action'] == 'Pending']
    if pending_rows_list:
        html += '<div class="section">\n'
        html += '<h2>⏳ 觀察名單 — Pending Data（量化摘要高 Sharpe 潛力股）</h2>\n'
        html += '<table>\n<tr><th>標的</th><th>來源</th><th>狀態</th></tr>\n'
        for p in pending_rows_list:
            html += '<tr>'
            html += '<td style="padding:6px 8px;border-bottom:1px solid #eee;">' + esc(p['display']) + '</td>'
            html += '<td style="padding:6px 8px;border-bottom:1px solid #eee;">' + esc(p.get('category', '-')) + '</td>'
            html += '<td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:center;">'
            html += '<span style="background:#9b59b6;color:#fff;padding:2px 8px;border-radius:4px;font-size:12px;">Pending Data</span></td>'
            html += '</tr>\n'
        html += '</table>\n</div>\n\n'

    html += '<p class="footer">Hermes Sentinel PMFX v3.1 | ' + esc(today) + ' | 含滑點(0.1%)+佣金(0.05%) | Hana 自動生成</p>\n'
    html += '</div>\n</body>\n</html>'

    return html


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 6: ENGINE (原 engine.py)
# ═══════════════════════════════════════════════════════════════════════════════

def _multi_vote(signals: list[dict]) -> dict:
    weights = {"trend": 1.5, "mean_rev": 1.0, "breakout": 1.2, "swing": 0.8}
    keys    = ["trend", "mean_rev", "breakout", "swing"]
    score   = sum(
        signals[i].get("signal", 0) * signals[i].get("score", 0) * weights[keys[i]]
        for i in range(len(signals))
    )
    votes   = sum(1 for s in signals if s.get("signal", 0) > 0) - \
              sum(1 for s in signals if s.get("signal", 0) < 0)
    if score > 1.2 or votes >= 2:
        action = "買"
    elif score < -1.0 or votes <= -2:
        action = "沽"
    else:
        action = "觀望"
    return {
        "action":     action,
        "vote_score": round(score, 3),
        "vote_count": votes,
    }

def _build_signal_row(
    ticker: str,
    hist: pd.DataFrame,
    settings: Any,
    benchmark: pd.Series | None = None,
    sim_paths: int = 2500,
    sim_steps: int = 300,
    seed: int = 42,
) -> dict:
    # 【Fix 1】用真實日期做 index：metrics() 同 beta 都要 DatetimeIndex
    # 原本 hist 係 reset_index(drop=True) → RangeIndex → (index[-1]-index[0]).days 會 AttributeError
    if "Date" in hist.columns:
        _idx = pd.to_datetime(hist["Date"], errors="coerce")
        close = pd.Series(hist["Close"].astype(float).to_numpy(), index=_idx).dropna()
        close = close[~close.index.isna()]
    else:
        close = hist["Close"].astype(float).dropna()
    m     = metrics(close, benchmark)
    if not m:
        return {}

    tr = trend_following(close)
    mr = mean_reversion(close)
    bo = breakout(close)
    sw = intraday_swing(hist)

    vote = _multi_vote([tr, mr, bo, sw])

    sup, res = support_resistance(close)
    a        = atr(hist)
    rs       = rsi(close)
    last     = float(close.iloc[-1])

    paths = monte_carlo_gbm(close, n_paths=sim_paths, n_steps=sim_steps, seed=seed)
    pct   = percentile_table(paths, [10, 20, 50, 100, 300])
    p20   = pct[pct["day"] == 20].iloc[0] if len(pct[pct["day"] == 20]) else None

    p25 = float(p20["p25"]) if p20 is not None else last
    p75 = float(p20["p75"]) if p20 is not None else last

    if vote["action"] == "買":
        entry  = min(last, p25)
        target = max(p75, res if pd.notna(res) else last * 1.04)
    elif vote["action"] == "沽":
        entry  = max(last, p75)
        target = min(p25, sup if pd.notna(sup) else last * 0.96)
        target = max(target, last * 0.01)
    else:
        entry  = last
        target = last

    # ─── 止蝕計算 ───
    # 【Fix 3】最低止損距離：避免 clamp 之後止損貼住 entry（risk≈0 → RR 爆表到 90+）
    min_dist = max(0.005 * entry, 0.5 * a if pd.notna(a) else 0.02 * entry)
    if vote["action"] == "沽":
        atr_stop = entry + 1.5 * a if pd.notna(a) else entry * 1.08
        res_stop = (res * 1.01) if pd.notna(res) else entry * 1.08
        stop     = min(atr_stop, res_stop)
        stop     = max(stop, entry * 1.001, entry + min_dist)
    else:
        atr_stop = entry - 1.5 * a if pd.notna(a) else entry * 0.92
        sup_stop = (sup * 0.99) if pd.notna(sup) else entry * 0.92
        stop     = max(min(atr_stop, sup_stop), entry * 0.01)
        stop     = min(stop, entry * 0.999, entry - min_dist)
        stop     = max(stop, entry * 0.01)

    risk   = max(abs(entry - stop), 1e-12)
    reward = max(abs(target - entry), 0.0)
    rr     = reward / risk if risk > 0 else np.nan

    # ─── 方向驗證閘門 ───
    if vote["action"] == "沽":
        if not (stop > entry > target):
            stop = entry * 1.02
            target = min(target, entry * 0.98)
            risk = max(abs(entry - stop), 1e-12)
            reward = max(abs(target - entry), 0.0)
            rr = reward / risk if risk > 0 else np.nan
    elif vote["action"] == "買":
        if not (stop < entry):
            stop = entry * 0.98
            risk = max(abs(entry - stop), 1e-12)
            reward = max(abs(target - entry), 0.0)
            rr = reward / risk if risk > 0 else np.nan

    # ─── RR Outlier Filter ───
    rr_valid = True
    if pd.notna(rr) and (rr < 0.5 or rr > 10.0):
        rr_valid = False

    opp  = 0.0
    opp += 2.0 if vote["action"] == "買" else 1.0 if vote["action"] == "沽" else 0.0
    opp += 1.0 if pd.notna(rr) and rr >= 2.0 else 0.0
    opp += 1.0 if m.get("sharpe", 0) > 1.0 else 0.0
    opp += 1.0 if m.get("max_drawdown", -1.0) > -0.15 else 0.0  # 【Fix 4a】default -1：缺數據唔加分
    opp += 1.0 if rs < 30 or rs > 70 else 0.0
    opp += 0.5 if abs(vote["vote_score"]) > 1.5 else 0.0

    # Confidence
    conf_vote = min(abs(vote.get("vote_score", 0)) * 0.06, 0.24)
    conf_sharpe = 0.05 if m.get("sharpe", 0) > 1.0 else 0.0
    conf_rsi = 0.03 if (rs < 30 or rs > 70) else 0.0
    conf_rr = 0.04 if (pd.notna(rr) and rr >= 2.0) else 0.0
    success = float(np.clip(0.50 + conf_vote + conf_sharpe + conf_rsi + conf_rr, 0.05, 0.93))
    ev      = success * reward - (1 - success) * risk

    # ─── Net RR / Net EV ───
    _net_rr, _net_ev = calculate_net_rr_ev(entry, target, stop, vote["action"], success * 100)
    net_rr = _net_rr
    net_ev = _net_ev
    net_rr_valid = bool(rr_valid and pd.notna(net_rr) and net_rr >= 0.5)  # 【Fix 5】同 rr_valid 一致化

    return {
        "ticker":       ticker,
        "name":         settings.display_names.get(ticker, FALLBACK_NAMES.get(ticker, ticker)),
        **m,
        "trend_signal":   tr.get("signal",  0), "trend_reason":   tr.get("reason",  ""),
        "mean_signal":    mr.get("signal",  0), "mean_reason":    mr.get("reason",  ""),
        "break_signal":   bo.get("signal",  0), "break_reason":   bo.get("reason",  ""),
        "swing_signal":   sw.get("signal",  0), "swing_reason":   sw.get("reason",  ""),
        "action":         vote["action"],
        "vote_score":     vote["vote_score"],
        "vote_count":     vote["vote_count"],
        "opportunity_score": round(opp, 2),
        "entry_price":    round(entry,  8),
        "target_price":   round(target, 8),
        "stop_loss":      round(stop,  8),
        "success_rate":   round(success, 4),
        "reward_risk":    round(float(rr), 3) if pd.notna(rr) else np.nan,
        "rr_valid":       rr_valid,
        "expected_value": round(ev, 8),
        "net_rr":         round(float(net_rr), 3) if net_rr is not None else np.nan,
        "net_ev":         round(float(net_ev), 8) if net_ev is not None else np.nan,
        "net_rr_valid":   net_rr_valid,
        "last_price":     round(last, 8),
        "support":        round(float(sup), 8) if pd.notna(sup) else np.nan,
        "resistance":     round(float(res), 8) if pd.notna(res) else np.nan,
        "atr14":          round(float(a),   8) if pd.notna(a)   else np.nan,
        "rsi14":          round(rs, 2),
        "p10_20d": round(float(p20["p10"]), 8) if p20 is not None else np.nan,
        "p25_20d": round(float(p20["p25"]), 8) if p20 is not None else np.nan,
        "p50_20d": round(float(p20["p50"]), 8) if p20 is not None else np.nan,
        "p75_20d": round(float(p20["p75"]), 8) if p20 is not None else np.nan,
        "p90_20d": round(float(p20["p90"]), 8) if p20 is not None else np.nan,
    }

def _load_quant_watchlist(output_base: str, today: str) -> list[dict]:
    """從量化摘要中提取高 Sharpe 潛力股作為動態觀察名單"""
    _GOLD_ETF_ALIASES = {
        "GLD", "IAU", "SGOL", "AAAU", "BAR", "GLDM", "IAUM", "SGOL",
        "2800.HK", "3404.HK", "2840.HK",
        "GOLD.L", "SGLD.L",
    }
    _GOLD_ETF_CANONICAL = "2840.HK"

    try:
        parts = today.split('-')
        today_iso = f"{parts[2]}-{parts[1]}-{parts[0]}"
    except Exception:
        today_iso = today

    watchlist = []
    for market in ['quant-us', 'quant-hk']:
        pattern = f"{output_base}/{market}/output/summary_*.md"
        files = sorted(_glob.glob(pattern), reverse=True)
        for f in files:
            if f.endswith(f"summary_{today_iso}.md"):
                continue
            try:
                text = open(f, 'r', encoding='utf-8').read()
                in_top = False
                count = 0
                for line in text.splitlines():
                    if 'Top' in line and 'Sharpe' in line:
                        in_top = True
                        continue
                    if in_top and line.startswith('- **'):
                        m = re.match(r'- \*\*(.+?)\*\*:\s*Sharpe=([\d.]+)', line)
                        if m and count < 5:
                            ticker = m.group(1)
                            if ticker in _GOLD_ETF_ALIASES:
                                ticker = _GOLD_ETF_CANONICAL
                            sharpe = float(m.group(2))
                            watchlist.append({
                                'ticker': ticker,
                                'sharpe': sharpe,
                                'source': market,
                            })
                            count += 1
                    elif in_top and line.strip() and not line.startswith('-'):
                        break
                break
            except Exception:
                continue
    return watchlist

def run_once(config_path: str = "configs/config.yaml") -> dict:
    settings = load_settings(config_path)
    out      = settings.app.output_dir
    today    = pd.Timestamp.today().strftime("%d-%m-%Y")
    day_dir  = Path(out) / today
    for sub in ("data", "reports", "raw", "logs"):
        (day_dir / sub).mkdir(parents=True, exist_ok=True)

    universe  = settings.full_universe
    failures: list[dict]         = []
    rows:     list[dict]         = []
    price_rows: list[pd.DataFrame] = []

    logger.info("=== Hermes Sentinel PMFX %s | %d tickers ===", today, len(universe))

    bdata     = download_history("DX-Y.NYB", settings.market.history_period, settings.market.interval)
    benchmark = bdata["Close"].astype(float) if not bdata.empty else None

    for idx, ticker in enumerate(universe):
        if idx > 0:
            delay = random.uniform(1.0, 2.5)
            logger.info("Pacing mechanism activated. Sleeping for %.2f seconds...", delay)
            time.sleep(delay)

        logger.info("  Analyzing [%d/%d] %s", idx+1, len(universe), ticker)
        hist = download_history(ticker, settings.market.history_period, settings.market.interval)
        if hist.empty or "Close" not in hist.columns or len(hist) < settings.market.min_history:
            failures.append({"ticker": ticker, "reason": "insufficient_history"})
            continue

        hist.to_csv(
            day_dir / "raw" / f"raw_{ticker.replace('=','_').replace('^','IDX')}_{today}.csv",
            index=False
        )
        price_rows.append(hist[["Date", "Close"]].assign(ticker=ticker))

        row = _build_signal_row(
            ticker, hist,
            settings=settings,
            benchmark=benchmark,
            sim_paths=settings.market.sim_paths,
            sim_steps=settings.market.sim_steps,
            seed=settings.app.seed,
        )
        if row:
            rows.append(row)

    df = pd.DataFrame(rows)
    if not df.empty:
        df["opportunity_score"] = df["opportunity_score"].fillna(0)
        df = df.sort_values(
            ["opportunity_score", "success_rate", "reward_risk"],
            ascending=False
        ).reset_index(drop=True)
        df["rank"] = range(1, len(df) + 1)

    # ─── 動態觀察名單 ───
    _project_root = Path(__file__).resolve().parent.parent
    _hermes_root = _project_root.parent
    _wl = _load_quant_watchlist(str(_hermes_root), today)
    _existing_tickers = set(df['ticker'].tolist()) if not df.empty else set()
    _new_tickers = [w for w in _wl if w['ticker'] not in _existing_tickers]

    if _new_tickers:
        logger.info("動態觀察名單: %d 個新標的待分析", len(_new_tickers))
        _wl_rows = []
        _wl_pending = []
        for w in _new_tickers:
            ticker = w['ticker']
            logger.info("  [觀察名單] 嘗試獲取 %s (Sharpe=%.2f, %s)", ticker, w['sharpe'], w['source'])
            try:
                hist = download_history(ticker, settings.market.history_period, settings.market.interval)
                if hist.empty or len(hist) < settings.market.min_history:
                    _wl_pending.append(ticker)
                    logger.warning("  [觀察名單] %s 數據不足，標記 Pending", ticker)
                    continue
                row = _build_signal_row(
                    ticker, hist, settings=settings, benchmark=benchmark,
                    sim_paths=settings.market.sim_paths,
                    sim_steps=settings.market.sim_steps,
                    seed=settings.app.seed,
                )
                if row:
                    row['source'] = w['source']
                    row['quant_sharpe'] = w['sharpe']
                    _wl_rows.append(row)
                    logger.info("  [觀察名單] %s 完成分析", ticker)
            except Exception as e:
                _wl_pending.append(ticker)
                logger.warning("  [觀察名單] %s 失敗: %s", ticker, e)

        if _wl_rows:
            wl_df = pd.DataFrame(_wl_rows)
            if not df.empty:
                df = pd.concat([df, wl_df], ignore_index=True)
            else:
                df = wl_df
            df = df.sort_values("opportunity_score", ascending=False).reset_index(drop=True)
            df["rank"] = range(1, len(df) + 1)
            logger.info("動態觀察名單: %d 個成功加入分析", len(_wl_rows))

        if _wl_pending:
            logger.info("動態觀察名單: %d 個 Pending Data: %s", len(_wl_pending), ', '.join(_wl_pending))
            pending_df = pd.DataFrame([{
                'ticker': pt, 'name': FALLBACK_NAMES.get(pt, pt),
                'action': 'Pending', 'opportunity_score': 0,
                'success_rate': 0, 'reward_risk': 0,
                'entry_price': 0, 'target_price': 0, 'stop_loss': 0,
                'last_price': 0, 'expected_value': 0,
                'vote_score': 0, 'vote_count': 0,
                # 【Fix 4b】0/0 唔係 valid；原本 True 會令下游以為有有效訊號
                'rr_valid': False,
                'source': next((w['source'] for w in _wl if w['ticker'] == pt), ''),
                'quant_sharpe': next((w['sharpe'] for w in _wl if w['ticker'] == pt), None),
                'error': 'insufficient_history',
            } for pt in _wl_pending])
            df = pd.concat([df, pending_df], ignore_index=True)

    prices = pd.concat(price_rows, ignore_index=True) if price_rows else pd.DataFrame()

    cross  = cross_asset_summary(prices)
    dxy_corr = pd.DataFrame()
    fx_corr  = pd.DataFrame()

    if not prices.empty:
        fx_corr = fx_strength_matrix(prices)
        fx_corr.to_csv(day_dir / "data" / f"fx_strength_matrix_{today}.csv")
        if benchmark is not None:
            dxy_corr = dollar_index_correlation(prices, benchmark)
            dxy_corr.to_csv(day_dir / "data" / f"dxy_correlation_{today}.csv")

    gold   = prices[prices["ticker"] == "XAUUSD=X"].sort_values("Date") if not prices.empty else pd.DataFrame()
    silver = prices[prices["ticker"] == "SI=F"].sort_values("Date") if not prices.empty else pd.DataFrame()
    if not gold.empty and not silver.empty:
        gr = gold_silver_ratio(
            gold.set_index("Date")["Close"].astype(float),
            silver.set_index("Date")["Close"].astype(float),
        )
        gr.reset_index().to_csv(day_dir / "data" / f"gold_silver_ratio_{today}.csv", index=False)

    rp_df    = build_risk_budget(df) if not df.empty else df
    port_stats = compute_portfolio_stats(df) if not df.empty else {}
    if not rp_df.empty:
        rp_df.to_csv(day_dir / "data" / f"risk_parity_{today}.csv", index=False)

    df.to_csv(day_dir / "data" / f"signals_{today}.csv", index=False)
    prices.to_csv(day_dir / "data" / f"prices_{today}.csv", index=False)
    pd.DataFrame(failures).to_csv(day_dir / "data" / f"failures_{today}.csv", index=False)

    for action_key, label in [("買", "buy_list"), ("沽", "sell_list"), ("觀望", "hold_list")]:
        sub = df[df["action"] == action_key] if not df.empty else pd.DataFrame()
        sub.to_csv(day_dir / "data" / f"{label}_{today}.csv", index=False)

    md = build_markdown(today, df, failures, port_stats, cross)
    (day_dir / "reports" / f"summary_{today}.md").write_text(md, encoding="utf-8")

    # ─── HTML 儀表板 ───
    if not df.empty:
        html_content = build_html(today, df, settings, cross)
        (day_dir / "reports" / f"dashboard_{today}.html").write_text(html_content, encoding="utf-8")
        logger.info("HTML 儀表板已生成: %s", day_dir / "reports" / f"dashboard_{today}.html")

    report = {
        "date":         today,
        "universe":     len(universe),
        "analyzed":     int(len(df)),
        "buy":          int((df["action"] == "買").sum())    if not df.empty else 0,
        "sell":         int((df["action"] == "沽").sum())    if not df.empty else 0,
        "hold":         int((df["action"] == "觀望").sum())  if not df.empty else 0,
        "portfolio":    port_stats,
        "cross_asset":  cross,
        "failures":     failures,
        "files":        sorted([p.name for p in (day_dir / "data").glob("*.csv")]),
    }
    (day_dir / "reports" / f"report_{today}.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2, default=str),
        encoding="utf-8"
    )

    alert_text = build_alert_text(today, df, settings.alerts.min_opportunity_score)
    if settings.alerts.telegram_enabled:
        send_telegram(alert_text)
    if settings.alerts.email_enabled:
        send_email(f"Hermes PMFX {today}", alert_text)

    if settings.alerts.trade_enabled and not df.empty:
        broker = get_broker(settings.broker.provider, settings.broker.endpoint, settings.broker.account_id)
        for _, r in df.iterrows():
            if r.get("opportunity_score", 0) >= settings.alerts.min_opportunity_score and r["action"] != "觀望":
                try:
                    broker.place_order(OrderIntent(
                        ticker=r["ticker"],
                        action=r["action"],
                        qty=1,
                        entry=float(r.get("entry_price", 0)),
                        stop=float(r.get("stop_loss", 0)),
                        target=float(r.get("target_price", 0)),
                    ))
                except Exception as e:
                    logger.error("下單失敗 %s: %s", r["ticker"], e)

    logger.info("完成。報告：%s", day_dir / "reports")

    # ── 自動部署到 ~/hermes reports/ ──
    try:
        from report_deployer import deploy_pmfx
        deploy_pmfx(today, str(day_dir))
        logger.info("✅ 已部署到 ~/hermes reports/")
    except Exception as e:
        logger.warning("⚠️ 部署失敗（不影響原報告）: %s", e)

    # ── Phase 6: Obsidian Vault write (failure-isolated, AM/PM separated) ──
    try:
        from report_deployer import _obsidian_write_summary, _date_dd_mm_to_iso
        from datetime import datetime as _dt
        # AM/PM detection from current HKT hour (cron: 07 morning, 19 evening)
        current_hour = _dt.now().hour
        slot = "morning" if current_hour < 12 else "evening"
        summary_md_path = day_dir / "reports" / f"summary_{today}.md"
        _obsidian_write_summary(
            system="pmfx",
            today=_date_dd_mm_to_iso(today),  # dd-mm-YYYY → YYYY-MM-DD
            summary_md_path=str(summary_md_path),
            extra_metadata={
                "cron_job_id": "2be814142adc" if slot == "morning" else "90e7c41e1e32",
                "schedule": "15 7 * * 1-5" if slot == "morning" else "15 19 * * 1-5",
            },
            slot=slot,
        )
    except Exception as e:
        logger.warning("⚠️ Obsidian write call failed (non-fatal): %s", e)

    return report
