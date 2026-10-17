"""
HK Quant Research — core.py
合併 data_sources + simulators + backtest + vol_surface + reporting
"""

from __future__ import annotations
import re
import math
import json
import logging
import os
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
import requests
import yfinance as yf
from scipy import stats as sp_stats
from scipy.interpolate import griddata
import plotly.graph_objects as go
import plotly.express as px

from config import HEADERS, FALLBACK_TICKERS, BENCHMARK_TICKER, CFG

logger = logging.getLogger("HKQuant")

# ════════════════════════════════════════
# 數據源
# ════════════════════════════════════════

HKEX_EQ_URL = 'https://www.hkex.com.hk/Market-Data/Securities-Prices/Equities?sc_lang=en'
HSI_TOP_URL = 'https://www.hangseng.com/en-hk/investment/market-express/top-movers/top-10-stocks/'
TV_ACTIVE_URL = 'https://www.tradingview.com/markets/stocks-hong-kong/market-movers-active/'
MOOMOO_ACTIVE_URL = 'https://www.moomoo.com/quote/hk/most-active-stocks'

FALLBACK_BLUE_CHIPS = [
    ['0700.HK', 'Tencent'], ['9988.HK', 'Alibaba'], ['3690.HK', 'Meituan'], ['0941.HK', 'China Mobile'],
    ['0005.HK', 'HSBC'], ['1299.HK', 'AIA'], ['0388.HK', 'HKEX'], ['0883.HK', 'CNOOC'],
    ['0939.HK', 'CCB'], ['1810.HK', 'Xiaomi'], ['2318.HK', 'Ping An'], ['0001.HK', 'CKH'],
    ['3328.HK', 'Bank of Comm'], ['0016.HK', 'Sun Hung Kai'], ['1038.HK', 'CKI'], ['2018.HK', 'AAC'],
    ['1211.HK', 'BYD'], ['0992.HK', 'Lenovo'], ['2269.HK', 'WuXi Bio'], ['0027.HK', 'Galaxy'],
    ['2628.HK', 'China Life'], ['3988.HK', 'BOC'], ['1398.HK', 'ICBC'], ['1928.HK', 'Sands China'],
    ['0011.HK', 'Hang Seng'], ['0066.HK', 'MTR Corporation'], ['0267.HK', 'CITIC'], ['0288.HK', 'WH Group'],
    ['0669.HK', 'Techtronic'], ['1088.HK', 'China Shenhua'], ['1109.HK', 'China Resources Land'], ['2020.HK', 'ANTA'],
    ['2319.HK', 'Mengniu'], ['2331.HK', 'Li Ning'], ['2382.HK', 'Sunny Optical'], ['2688.HK', 'ENN Energy'],
    ['3692.HK', 'Budweiser APAC'], ['6098.HK', 'CG Services'], ['6862.HK', 'Haidilao'], ['9618.HK', 'JD.com'],
    ['9633.HK', 'Nongfu Spring'], ['9888.HK', 'Baidu'], ['9961.HK', 'Trip.com'], ['9999.HK', 'NetEase'],
    ['0002.HK', 'CLP Holdings'], ['0003.HK', 'HK & China Gas'], ['0006.HK', 'Power Assets'], ['0012.HK', 'Henderson Land'],
    ['0017.HK', 'New World Dev'], ['0083.HK', 'Sino Land'], ['0101.HK', 'Hang Lung Prop'], ['0175.HK', 'Geely Auto'],
    ['0291.HK', 'China Resources Beer'], ['0386.HK', 'Sinopec'], ['0688.HK', 'China Overseas'], ['0762.HK', 'China Unicom'],
    ['0857.HK', 'PetroChina'], ['0960.HK', 'Longfor Group'], ['0968.HK', 'Xinyi Solar'], ['1024.HK', 'Kuaishou'],
    ['1044.HK', 'Hengan Int'], ['1093.HK', 'CSPC Pharma'], ['1113.HK', 'CK Asset'], ['1177.HK', 'Sino Biopharm'],
    ['1378.HK', 'China Hongqiao'], ['1929.HK', 'Chow Tai Fook'], ['2015.HK', 'Li Auto'], ['2328.HK', 'PICC P&C'],
    ['2601.HK', 'CPIC'], ['2899.HK', 'Zijin Mining'], ['3968.HK', 'CM Bank'], ['6160.HK', 'Ascentage'],
    ['6618.HK', 'JD Health'], ['6690.HK', 'Haier Smart'], ['9626.HK', 'Bilibili'], ['9866.HK', 'NIO'],
    ['9868.HK', 'Xpeng'], ['9922.HK', 'Jiumaojiu'], ['9987.HK', 'Yum China'], ['9992.HK', 'Pop Mart'],
    ['0019.HK', 'Swire Pacific A'], ['0010.HK', 'Hang Lung Group'], ['0142.HK', 'First Pacific'], ['0241.HK', 'Alibaba Health'],
    ['0322.HK', 'Tingyi'], ['0354.HK', 'Chinasoft Int'], ['0435.HK', 'Sunlight REIT'], ['0551.HK', 'Yue Yuen'],
    ['0570.HK', 'China TCM'], ['0728.HK', 'China Telecom'], ['0753.HK', 'Air China'], ['0772.HK', 'China Lit'],
    ['0817.HK', 'China Jinmao'], ['0914.HK', 'Anhui Conch'], ['0981.HK', 'SMIC'], ['1066.HK', 'Weigao'],
    ['1199.HK', 'COSCO Shipping'], ['1313.HK', 'China Resources Cement'], ['1800.HK', 'CCCC'], ['2333.HK', 'Great Wall Motor'],
]


def _fetch_tables(url: str):
    try:
        html = requests.get(url, timeout=25, headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36'
        }).text
        return pd.read_html(html)
    except Exception:
        return []


def get_top_active_hk_stocks(limit: int = 20) -> pd.DataFrame:
    sources = [HSI_TOP_URL, TV_ACTIVE_URL, MOOMOO_ACTIVE_URL, HKEX_EQ_URL]
    for url in sources:
        try:
            tables = _fetch_tables(url)
            for tbl in tables:
                cols = [str(c).lower() for c in tbl.columns]
                if any('turnover' in c or 'volume' in c or 'traded' in c for c in cols):
                    df = tbl.copy()
                    if df.shape[1] >= 3:
                        df = df.iloc[:, :3]
                        df.columns = ['code', 'name', 'turnover']
                    elif df.shape[1] == 2:
                        df.columns = ['code', 'turnover']
                        df['name'] = ''
                    if 'code' in df.columns and 'name' in df.columns:
                        res_df = df[['code', 'name', 'turnover']].head(limit).reset_index(drop=True)
                        if len(res_df) >= limit:
                            return res_df
        except Exception:
            continue

    df = pd.DataFrame(FALLBACK_BLUE_CHIPS, columns=['code', 'name'])
    df['turnover'] = 'N/A'
    return df.head(limit).reset_index(drop=True)


def normalize_hk_ticker(code: str) -> str:
    c = str(code).strip().upper()
    if c.endswith('.HK'):
        return c
    if re.fullmatch(r'\d{1,5}', c):
        return c.zfill(4) + '.HK'
    return c


def download_history(ticker: str, period: str = '2y', interval: str = '1d') -> pd.DataFrame:
    df = yf.download(ticker, period=period, interval=interval, auto_adjust=True, progress=False, threads=False)
    if df.empty:
        return df
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = [c[0] if isinstance(c, tuple) else c for c in df.columns]
    df = df.reset_index()
    if 'Date' not in df.columns and 'index' in df.columns:
        df = df.rename(columns={'index': 'Date'})
    if 'Date' not in df.columns and df.index.name is None:
        df.index.name = 'Date'
        df = df.reset_index()
    if 'Close' in df.columns:
        df['ret'] = df['Close'].pct_change()
    return df


def download_option_chain(ticker: str) -> dict:
    tk = yf.Ticker(ticker)
    out = {}
    try:
        exps = list(tk.options)
    except Exception:
        exps = []
    for exp in exps[:6]:
        try:
            chain = tk.option_chain(exp)
            calls = chain.calls.copy()
            puts = chain.puts.copy()
            calls['type'] = 'call'
            puts['type'] = 'put'
            calls['expiration'] = exp
            puts['expiration'] = exp
            out[exp] = pd.concat([calls, puts], ignore_index=True)
        except Exception:
            continue
    return out


def get_risk_free_rate(fallback: float = 0.026) -> float:
    """HIBOR 1M → US 10Y → fallback"""
    try:
        url = "https://www.hkab.org.hk/DisplayInterestSettlementRatesAction.do"
        tables = pd.read_html(url, headers=HEADERS)
        for tbl in tables:
            for col in tbl.columns:
                if "1" in str(col) and ("month" in str(col).lower() or "m" in str(col).lower()):
                    vals = pd.to_numeric(tbl[col], errors="coerce").dropna()
                    if not vals.empty:
                        rate = float(vals.iloc[0]) / 100.0
                        logger.info(f"✅ HIBOR 1M: {rate:.2%}")
                        return rate
    except Exception:
        pass
    try:
        tnx = yf.Ticker("^TNX")
        hist = tnx.history(period="5d")
        if not hist.empty:
            rate = float(hist["Close"].iloc[-1]) / 100.0
            logger.info(f"✅ US 10Y (proxy): {rate:.2%}")
            return rate
    except Exception:
        pass
    logger.info(f"⚠️ Using fallback: {fallback:.2%}")
    return fallback


def fetch_top_tickers_yahoo() -> Optional[List[str]]:
    try:
        url = "https://finance.yahoo.com/markets/stocks/most-active/?start=0&count=100&country=hk"
        tables = pd.read_html(url)
        if tables:
            df = tables[0]
            if "Symbol" in df.columns:
                tickers = df["Symbol"].tolist()
                logger.info(f"✅ Yahoo: {len(tickers)} HK tickers")
                return tickers
    except Exception as e:
        logger.warning(f"⚠️ Yahoo scraping failed: {e}")
    return None


def fetch_top_tickers_finviz() -> Optional[List[str]]:
    try:
        url = "https://finviz.com/screener.ashx?v=111&f=cap_large,sh_avgvol_o500&o=-volume"
        tables = pd.read_html(url)
        for tbl in tables:
            if "Ticker" in tbl.columns:
                tickers = tbl["Ticker"].tolist()[:100]
                logger.info(f"✅ Finviz: {len(tickers)} tickers")
                return tickers
    except Exception as e:
        logger.warning(f"⚠️ Finviz scraping failed: {e}")
    return None


def get_tickers(no_scrape: bool, fallback: List[str], top_n: int) -> List[str]:
    MIN_TICKERS = 95
    if no_scrape:
        logger.info(f"Using fallback: {len(fallback)} tickers")
        return fallback[:top_n]
    tickers = fetch_top_tickers_yahoo() or fetch_top_tickers_finviz()
    if not tickers:
        logger.info(f"All scraping failed, using fallback: {len(fallback)} tickers")
        tickers = fallback
    valid = [t for t in tickers if isinstance(t, str) and len(t) <= 8]
    if len(valid) < MIN_TICKERS:
        logger.warning(f"⚠️ Scraping only returned {len(valid)} tickers (min={MIN_TICKERS}), forcing fallback")
        valid = [t for t in fallback if isinstance(t, str) and len(t) <= 8]
    return valid[:top_n]


def download_price_data(tickers: List[str]) -> Dict[str, pd.DataFrame]:
    import time
    import random
    data = {}
    failed = []
    for i, ticker in enumerate(tickers):
        if i > 0:
            delay = random.uniform(1.5, 3.5)
            time.sleep(delay)
        try:
            tkr = yf.Ticker(ticker)
            df = tkr.history(period="2y")
            if df.empty:
                failed.append(ticker)
                continue
            if isinstance(df.columns, pd.MultiIndex):
                df.columns = [c[0] if isinstance(c, tuple) else c for c in df.columns]
            data[ticker] = df
        except Exception:
            failed.append(ticker)
    logger.info(f"Downloaded: {len(data)}/{len(tickers)}, failed: {len(failed)}")
    if failed:
        logger.info(f"Failed: {failed[:10]}...")
    return data


def validate_price_data(data: Dict[str, pd.DataFrame], min_days: int = 30,
                        max_gap_days: int = 10) -> Dict[str, pd.DataFrame]:
    """驗證港股價格資料品質，剔除異常數據
    
    Checks:
    - 最少交易日數
    - 收盤價缺失 / NaN
    - 連續休市 gap 過大（ffill 前先標記）
    - 最後交易日距今太遠（stale data）
    - 零成交日比例過高
    """
    import datetime
    validated = {}
    issues = []
    today = pd.Timestamp.now().normalize()

    for ticker, df in data.items():
        if df is None or df.empty:
            issues.append(f"{ticker}: empty data")
            continue
        
        close = df["Close"] if "Close" in df.columns else df.get("Adj Close")
        if close is None:
            issues.append(f"{ticker}: no Close column")
            continue

        # Check minimum data length
        if len(close.dropna()) < min_days:
            issues.append(f"{ticker}: only {len(close.dropna())} days (need {min_days})")
            continue

        # Check last date freshness
        last_date = close.dropna().index[-1]
        if hasattr(last_date, 'tzinfo') and last_date.tzinfo is not None:
            last_date = last_date.tz_localize(None)
        if (today - last_date).days > max_gap_days:
            issues.append(f"{ticker}: stale data, last={last_date.date()}, gap={(today - last_date).days}d")

        # Check NaN ratio
        nan_ratio = close.isna().sum() / len(close)
        if nan_ratio > 0.1:
            issues.append(f"{ticker}: {nan_ratio:.0%} NaN in Close")

        # Check zero volume days (if Volume column exists)
        if "Volume" in df.columns:
            zero_vol_ratio = (df["Volume"] == 0).sum() / len(df)
            if zero_vol_ratio > 0.3:
                issues.append(f"{ticker}: {zero_vol_ratio:.0%} zero-volume days")

        validated[ticker] = df

    if issues:
        logger.warning(f"Data quality issues ({len(issues)}):")
        for issue in issues[:15]:
            logger.warning(f"  • {issue}")

    logger.info(f"Validated: {len(validated)}/{len(data)} tickers passed")
    return validated

@dataclass
class SimConfig:
    start_price: float
    drift: float = 0.0
    vol: float = 0.2
    n_paths: int = 50000
    n_steps: int = 252
    dt: float = 1 / 252
    seed: int = 42


@dataclass
class HestonConfig(SimConfig):
    kappa: float = 2.0
    theta: float = 0.04
    xi: float = 0.5
    rho: float = -0.7
    v0: float = 0.04


@dataclass
class JumpConfig(SimConfig):
    jump_intensity: float = 0.1
    jump_mean: float = -0.02
    jump_std: float = 0.05


class BootstrapSimulator:
    def __init__(self, returns, seed: int = 42):
        self.returns = np.asarray(returns.dropna())
        self.rng = np.random.default_rng(seed)

    def simulate(self, start_price: float, n_paths: int, n_steps: int):
        sampled = self.rng.choice(self.returns, size=(n_paths, n_steps), replace=True)
        growth = np.cumprod(1 + sampled, axis=1)
        paths = np.hstack([np.full((n_paths, 1), start_price), start_price * growth])
        return paths


class GBMSimulator:
    def __init__(self, config: SimConfig):
        self.c = config
        self.rng = np.random.default_rng(config.seed)

    def simulate(self):
        c = self.c
        Z = self.rng.standard_normal((c.n_paths, c.n_steps))
        log_ret = (c.drift - 0.5 * c.vol ** 2) * c.dt + c.vol * math.sqrt(c.dt) * Z
        paths = c.start_price * np.exp(np.cumsum(log_ret, axis=1))
        paths = np.hstack([np.full((c.n_paths, 1), c.start_price), paths])
        return paths


class HestonSimulator:
    def __init__(self, config: HestonConfig):
        self.c = config
        self.rng = np.random.default_rng(config.seed)

    def simulate(self):
        c = self.c
        paths = np.zeros((c.n_paths, c.n_steps + 1))
        v = np.zeros((c.n_paths, c.n_steps + 1))
        paths[:, 0] = c.start_price
        v[:, 0] = c.v0
        sqrt_dt = math.sqrt(c.dt)
        rho_comp = math.sqrt(max(1 - c.rho ** 2, 0))
        for t in range(1, c.n_steps + 1):
            z1 = self.rng.standard_normal(c.n_paths)
            z2 = self.rng.standard_normal(c.n_paths)
            w1 = z1
            w2 = c.rho * z1 + rho_comp * z2
            v_prev = np.maximum(v[:, t - 1], 0)
            v[:, t] = np.maximum(
                v[:, t - 1] + c.kappa * (c.theta - v[:, t - 1]) * c.dt + c.xi * np.sqrt(v_prev) * sqrt_dt * w2,
                1e-10
            )
            paths[:, t] = paths[:, t - 1] * np.exp(
                (c.drift - 0.5 * v_prev) * c.dt + np.sqrt(v_prev) * sqrt_dt * w1
            )
        return paths, v


class JumpDiffusionSimulator:
    def __init__(self, config: JumpConfig):
        self.c = config
        self.rng = np.random.default_rng(config.seed)

    def simulate(self):
        c = self.c
        Z = self.rng.standard_normal((c.n_paths, c.n_steps))
        jumps = self.rng.poisson(c.jump_intensity * c.dt, size=(c.n_paths, c.n_steps))
        jump_sizes = self.rng.normal(c.jump_mean, c.jump_std, size=(c.n_paths, c.n_steps)) * jumps
        log_ret = (c.drift - 0.5 * c.vol ** 2) * c.dt + c.vol * math.sqrt(c.dt) * Z + jump_sizes
        paths = c.start_price * np.exp(np.cumsum(log_ret, axis=1))
        paths = np.hstack([np.full((c.n_paths, 1), c.start_price), paths])
        return paths


# ════════════════════════════════════════
# 回測指標
# ════════════════════════════════════════

def calc_returns(prices: pd.Series) -> pd.Series:
    return prices.pct_change().dropna()


def calc_sharpe(returns: pd.Series, rf: float) -> float:
    if returns.empty or returns.std() == 0:
        return np.nan
    return (returns.mean() * 252 - rf) / (returns.std() * np.sqrt(252))


def calc_sortino(returns: pd.Series, rf: float) -> float:
    if returns.empty:
        return np.nan
    daily_rf = rf / 252
    excess = returns - daily_rf
    downside = excess[excess < 0]
    if downside.empty or downside.std() == 0:
        return np.nan
    return (excess.mean() * 252) / (downside.std() * np.sqrt(252))


def calc_max_drawdown(prices: pd.Series) -> float:
    if prices.empty:
        return np.nan
    peak = prices.expanding(min_periods=1).max()
    dd = (prices - peak) / peak
    return dd.min()


def calc_max_dd_duration(prices: pd.Series) -> int:
    if prices.empty:
        return 0
    peak = prices.expanding(min_periods=1).max()
    in_dd = prices < peak
    dd_groups = (~in_dd).cumsum()
    if in_dd.sum() == 0:
        return 0
    return int(in_dd.groupby(dd_groups).sum().max())


def calc_cagr(prices: pd.Series) -> float:
    if prices.empty or len(prices) < 2:
        return np.nan
    total = prices.iloc[-1] / prices.iloc[0]
    n_days = (prices.index[-1] - prices.index[0]).days
    if n_days <= 0:
        return np.nan
    return total ** (365.0 / n_days) - 1


def calc_calmar(returns: pd.Series, mdd: float) -> float:
    if returns.empty or mdd == 0 or np.isnan(mdd):
        return np.nan
    return (returns.mean() * 252) / abs(mdd)


def calc_var(returns: pd.Series, confidence: float) -> float:
    if returns.empty:
        return np.nan
    return returns.quantile(1 - confidence)


def calc_parametric_var(returns: pd.Series, confidence: float) -> float:
    if returns.empty:
        return np.nan
    mu = returns.mean()
    sigma = returns.std()
    z = sp_stats.norm.ppf(1 - confidence)
    return mu + z * sigma


def calc_cvar(returns: pd.Series, confidence: float) -> float:
    if returns.empty:
        return np.nan
    var = calc_var(returns, confidence)
    return returns[returns <= var].mean()


def calc_beta(returns: pd.Series, bench_returns: pd.Series) -> float:
    if len(returns) < 20 or len(bench_returns) < 20:
        return np.nan
    aligned = pd.concat([returns, bench_returns], axis=1).dropna()
    if len(aligned) < 20:
        return np.nan
    cov = np.cov(aligned.iloc[:, 0], aligned.iloc[:, 1])
    if cov[1, 1] == 0:
        return np.nan
    return cov[0, 1] / cov[1, 1]


class Backtester:
    def equity_curve(self, prices: pd.Series) -> pd.DataFrame:
        df = pd.DataFrame({"price": prices.values}, index=prices.index)
        df["equity"] = df["price"] / df["price"].iloc[0]
        df["drawdown"] = df["equity"] / df["equity"].cummax() - 1
        return df

    def metrics(self, equity: pd.Series, rf: float = 0.026, freq: int = 252):
        ret = equity.pct_change().dropna()
        total_return = equity.iloc[-1] / equity.iloc[0] - 1
        if isinstance(equity.index, pd.DatetimeIndex):
            n_days = (equity.index[-1] - equity.index[0]).days
            cagr = (equity.iloc[-1] / equity.iloc[0]) ** (365.0 / max(n_days, 1)) - 1
        else:
            cagr = (equity.iloc[-1] / equity.iloc[0]) ** (freq / max(len(equity) - 1, 1)) - 1
        vol = ret.std() * math.sqrt(freq)
        sharpe = (ret.mean() * freq - rf) / (ret.std() * math.sqrt(freq) + 1e-12)
        daily_rf = rf / freq
        excess = ret - daily_rf
        downside = excess[excess < 0]
        sortino = (excess.mean() * freq) / (downside.std() * math.sqrt(freq) + 1e-12)
        dd = equity / equity.cummax() - 1
        mdd = dd.min()
        calmar = cagr / abs(mdd + 1e-12)
        return {
            "total_return": float(total_return), "cagr": float(cagr),
            "volatility": float(vol), "sharpe": float(sharpe),
            "sortino": float(sortino), "calmar": float(calmar),
            "max_drawdown": float(mdd),
        }


# ════════════════════════════════════════
# 波動率曲面
# ════════════════════════════════════════

class VolatilitySurface:
    def __init__(self, options_df: pd.DataFrame):
        self.df = options_df.copy()

    def preprocess(self) -> pd.DataFrame:
        df = self.df.copy()
        if 'strike' not in df.columns or 'impliedVolatility' not in df.columns:
            raise ValueError('options_df must contain strike and impliedVolatility')
        if 'expiration' not in df.columns and 'days_to_exp' not in df.columns:
            raise ValueError('options_df must contain expiration or days_to_exp')
        if 'days_to_exp' not in df.columns:
            df['days_to_exp'] = (pd.to_datetime(df['expiration']) - pd.Timestamp.today()).dt.days.clip(lower=1)
        if 'underlier_price' not in df.columns:
            raise ValueError("options_df 必須包含 'underlier_price' 欄位。")
        df['moneyness'] = df['strike'] / df['underlier_price']
        df = df.replace([np.inf, -np.inf], np.nan).dropna(subset=['moneyness', 'days_to_exp', 'impliedVolatility'])
        return df

    def calibrate(self) -> pd.DataFrame:
        return self.preprocess().sort_values(['days_to_exp', 'moneyness']).reset_index(drop=True)

    def interpolate_iv(self, moneyness: float, days_to_exp: float) -> float:
        df = self.calibrate()
        pts = df[['moneyness', 'days_to_exp']].to_numpy()
        vals = df['impliedVolatility'].to_numpy()
        iv = griddata(pts, vals, np.array([[moneyness, days_to_exp]]), method='linear')
        if np.isnan(iv).any():
            iv = griddata(pts, vals, np.array([[moneyness, days_to_exp]]), method='nearest')
        return float(iv)

    def build_surface_grid(self, x_points: int = 40, y_points: int = 40):
        df = self.calibrate()
        x = np.linspace(df['days_to_exp'].min(), df['days_to_exp'].max(), x_points)
        y = np.linspace(df['moneyness'].min(), df['moneyness'].max(), y_points)
        xx, yy = np.meshgrid(x, y)
        zz = griddata(
            df[['days_to_exp', 'moneyness']].to_numpy(),
            df['impliedVolatility'].to_numpy(), (xx, yy), method='linear'
        )
        if np.isnan(zz).any():
            zz2 = griddata(
                df[['days_to_exp', 'moneyness']].to_numpy(),
                df['impliedVolatility'].to_numpy(), (xx, yy), method='nearest'
            )
            zz = np.where(np.isnan(zz), zz2, zz)
        return x, y, zz


# ════════════════════════════════════════
# Monte Carlo + 圖表
# ════════════════════════════════════════

def monte_carlo_gbm(prices: pd.Series, n_paths: int = 50000,
                    horizon: int = 252) -> Optional[pd.DataFrame]:
    returns = calc_returns(prices)
    if len(returns) < 20:
        return None
    mu = returns.mean()
    sigma = returns.std()
    s0 = float(prices.iloc[-1])
    dt = 1 / 252
    rng = np.random.default_rng(42)
    Z = rng.standard_normal((n_paths, horizon))
    log_returns = (mu - 0.5 * sigma**2) * dt + sigma * np.sqrt(dt) * Z
    paths = s0 * np.exp(np.cumsum(log_returns, axis=1))
    paths = np.hstack([np.full((n_paths, 1), s0), paths])
    return pd.DataFrame(paths.T)


def generate_fan_chart(ticker: str, mc_df: pd.DataFrame, save_dir: str,
                       price_label: str = "Price (HKD)") -> Optional[str]:
    path = os.path.join(save_dir, f"fan_{ticker.replace('.', '_')}.png")
    try:
        q10 = mc_df.quantile(0.10, axis=1)
        q25 = mc_df.quantile(0.25, axis=1)
        q50 = mc_df.quantile(0.50, axis=1)
        q75 = mc_df.quantile(0.75, axis=1)
        q90 = mc_df.quantile(0.90, axis=1)
        fig = go.Figure()
        fig.add_trace(go.Scatter(x=q50.index, y=q50, mode='lines', name='P50', line=dict(color='blue')))
        fig.add_trace(go.Scatter(x=q75.index, y=q75, mode='lines', line=dict(width=0), showlegend=False))
        fig.add_trace(go.Scatter(x=q25.index, y=q25, mode='lines', fill='tonexty', line=dict(width=0), name='P25-P75', fillcolor='rgba(0,100,200,0.2)'))
        fig.add_trace(go.Scatter(x=q90.index, y=q90, mode='lines', line=dict(width=0), showlegend=False))
        fig.add_trace(go.Scatter(x=q10.index, y=q10, mode='lines', fill='tonexty', line=dict(width=0), name='P10-P90', fillcolor='rgba(0,100,200,0.1)'))
        fig.update_layout(
            title=f"Monte Carlo Fan Chart — {ticker}",
            xaxis_title="Trading Days", yaxis_title=price_label,
            template="plotly_white",
        )
        fig.write_image(path, width=1200, height=600)
        return path
    except Exception as e:
        logger.warning(f"Plotly fan chart failed for {ticker}, falling back to matplotlib: {e}")
        # Fallback: use matplotlib (no Chrome dependency) when kaleido unavailable
        try:
            import matplotlib
            matplotlib.use('Agg')
            import matplotlib.pyplot as plt
            q10 = mc_df.quantile(0.10, axis=1)
            q25 = mc_df.quantile(0.25, axis=1)
            q50 = mc_df.quantile(0.50, axis=1)
            q75 = mc_df.quantile(0.75, axis=1)
            q90 = mc_df.quantile(0.90, axis=1)
            n = len(q50)
            mpl_fig, ax = plt.subplots(figsize=(12, 6))
            ax.plot(q50.values, color='blue', label='P50', linewidth=1.5)
            ax.fill_between(range(n), q10.values, q90.values, alpha=0.10, color='steelblue', label='P10-P90')
            ax.fill_between(range(n), q25.values, q75.values, alpha=0.20, color='steelblue', label='P25-P75')
            ax.set_title(f"Monte Carlo Fan Chart — {ticker}")
            ax.set_xlabel("Trading Days")
            ax.set_ylabel(price_label)
            ax.legend(loc='upper left')
            ax.grid(True, alpha=0.3)
            mpl_fig.tight_layout()
            mpl_fig.savefig(path, dpi=80)
            plt.close(mpl_fig)
            return path
        except Exception as mpl_e:
            logger.warning(f"Matplotlib fan chart also failed for {ticker}: {mpl_e}")
            return None


# ════════════════════════════════════════
# 報告工具
# ════════════════════════════════════════

def save_csv(df: pd.DataFrame, path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(path, index=False, encoding='utf-8-sig')


def save_json(obj, path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


def save_chart(fig, path: Path, caption: str, description: str = ''):
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fig.write_image(str(path))
    except Exception as e:
        logger.warning(f"Plotly write_image failed for {path.name}, falling back to matplotlib placeholder: {e}")
        # Fallback: minimal matplotlib placeholder PNG (no chart, just caption text)
        try:
            import matplotlib
            matplotlib.use('Agg')
            import matplotlib.pyplot as plt
            mpl_fig, ax = plt.subplots(figsize=(10, 6))
            ax.text(0.5, 0.5, caption, ha='center', va='center', fontsize=14, wrap=True)
            ax.set_title(description[:80] if description else caption)
            ax.axis('off')
            mpl_fig.tight_layout()
            mpl_fig.savefig(str(path), dpi=80)
            plt.close(mpl_fig)
        except Exception as mpl_e:
            logger.warning(f"Matplotlib placeholder also failed for {path.name}: {mpl_e}")
            return  # Skip meta write if all fallbacks fail
    with open(str(path) + '.meta.json', 'w', encoding='utf-8') as f:
        json.dump({'caption': caption, 'description': description}, f, ensure_ascii=False, indent=2)


def make_line_chart(df: pd.DataFrame, x: str, y: str, title: str, xlab: str, ylab: str, fill: str = 'none'):
    fig = px.line(df, x=x, y=y, title=title)
    fig.update_xaxes(title_text=xlab)
    fig.update_yaxes(title_text=ylab)
    if fill != 'none':
        fig.update_traces(fill=fill)
    return fig


def make_hist_chart(series, title: str, xlab: str, ylab: str):
    fig = px.histogram(x=series, nbins=40, title=title)
    fig.update_xaxes(title_text=xlab)
    fig.update_yaxes(title_text=ylab)
    return fig


def make_iv_surface_3d(x_days, y_moneyness, z_iv, title: str):
    fig = go.Figure(data=[go.Surface(x=x_days, y=y_moneyness, z=z_iv, colorscale='Viridis')])
    fig.update_layout(title=title, scene=dict(xaxis_title='Days', yaxis_title='Moneyness', zaxis_title='IV'))
    return fig


def make_report_index(items):
    lines = ['# Figure Index', '']
    for i, item in enumerate(items, 1):
        lines.append(f'{i}. {item}')
    return '\n'.join(lines)


# ════════════════════════════════════════
# HTML 報告
# ════════════════════════════════════════

def generate_html_report(today: str, metrics_df: pd.DataFrame, summary: Dict,
                         charts: List[str], save_dir: str,
                         market: str = "HK", price_unit: str = "HKD",
                         lookback_days: int = 504) -> str:
    html = f"""<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<title>{market} Quant Research — {today}</title>
<style>
body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 1400px; margin: 0 auto; padding: 20px; background: #f5f5f5; }}
.header {{ background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%); color: white; padding: 30px; border-radius: 10px; margin-bottom: 20px; }}
.header h1 {{ margin: 0; font-size: 2em; }}
.header p {{ margin: 5px 0 0; opacity: 0.8; }}
.stats {{ display: flex; gap: 15px; margin: 15px 0; flex-wrap: wrap; }}
.stat {{ background: rgba(255,255,255,0.1); padding: 15px 20px; border-radius: 8px; flex: 1; min-width: 150px; }}
.stat .value {{ font-size: 1.8em; font-weight: bold; }}
.stat .label {{ font-size: 0.85em; opacity: 0.7; }}
table {{ width: 100%; border-collapse: collapse; margin: 15px 0; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }}
th {{ background: #1a1a2e; color: white; padding: 12px; text-align: left; font-size: 0.9em; }}
td {{ padding: 10px 12px; border-bottom: 1px solid #eee; font-size: 0.9em; }}
tr:hover td {{ background: #f0f0ff; }}
.section {{ background: white; padding: 20px; border-radius: 10px; margin: 15px 0; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }}
h2 {{ color: #333; border-bottom: 2px solid #0f3460; padding-bottom: 10px; }}
.positive {{ color: #00c853; }}
.negative {{ color: #ff1744; }}
.charts {{ display: flex; flex-wrap: wrap; gap: 15px; }}
.charts img {{ max-width: 48%; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.15); }}
</style>
</head>
<body>
<div class="header">
<h1>📊 {market} Quant Research</h1>
<p>Daily Report — {today}</p>
<div class="stats">
<div class="stat"><div class="value">{summary.get('total_tickers', 0)}</div><div class="label">Tickers</div></div>
<div class="stat"><div class="value">{summary.get('success_rate', 0):.1%}</div><div class="label">Success Rate</div></div>
<div class="stat"><div class="value">{summary.get('risk_free_rate', 0):.2%}</div><div class="label">Risk-Free Rate</div></div>
<div class="stat"><div class="value">{summary.get('mc_paths', 0):,}</div><div class="label">MC Paths</div></div>
</div>
</div>
"""
    if not metrics_df.empty:
        top_sharpe = metrics_df.nlargest(15, 'sharpe')
        html += '<div class="section"><h2>🏆 Top 15 by Sharpe Ratio</h2><table>'
        html += "<tr><th>Ticker</th><th>Price</th><th>Daily</th><th>CAGR</th><th>Vol</th><th>Sharpe</th><th>Sortino</th><th>MDD</th><th>Beta</th><th>VaR 95%</th></tr>"
        for _, r in top_sharpe.iterrows():
            daily_class = 'positive' if r['daily_return'] >= 0 else 'negative'
            html += (
                f"<tr><td><b>{r['ticker']}</b></td>"
                f"<td>${r['last_price']:.2f}</td>"
                f"<td class='{daily_class}'>{r['daily_return']:.2%}</td>"
                f"<td>{r['cagr']:.2%}</td>"
                f"<td>{r['volatility']:.2%}</td>"
                f"<td><b>{r['sharpe']:.2f}</b></td>"
                f"<td>{r['sortino']:.2f}</td>"
                f"<td class='negative'>{r['max_drawdown']:.2%}</td>"
                f"<td>{r['beta']:.2f}</td>"
                f"<td>{r['var_95']:.2%}</td></tr>"
            )
        html += "</table></div>"

        worst_dd = metrics_df.nsmallest(10, 'max_drawdown')
        html += '<div class="section"><h2>⚠️ Worst 10 Max Drawdowns</h2><table>'
        html += "<tr><th>Ticker</th><th>MDD</th><th>MDD Duration</th><th>CAGR</th><th>Calmar</th><th>CVaR 95%</th></tr>"
        for _, r in worst_dd.iterrows():
            html += (
                f"<tr><td><b>{r['ticker']}</b></td>"
                f"<td class='negative'>{r['max_drawdown']:.2%}</td>"
                f"<td>{r['max_dd_duration']} days</td>"
                f"<td>{r['cagr']:.2%}</td>"
                f"<td>{r['calmar']:.2f}</td>"
                f"<td>{r['cvar_95']:.2%}</td></tr>"
            )
        html += "</table></div>"

    if charts:
        html += '<div class="section"><h2>📈 Charts</h2><div class="charts">'
        for c in charts:
            fname = os.path.basename(c)
            html += f'<img src="../charts/{fname}" alt="{fname}">'
        html += '</div></div>'

    html += f"""
<div class="section">
<h2>🔧 Methodology</h2>
<ul>
<li>Risk-Free Rate: {summary.get('risk_free_rate', 0):.2%} (HIBOR 1M / US 10Y)</li>
<li>Annualization: 252 trading days</li>
<li>VaR/CVaR Confidence: 95%</li>
<li>Monte Carlo: {summary.get('mc_paths', 0):,} GBM paths, {summary.get('mc_horizon', 252)}-day horizon</li>
<li>Lookback: {lookback_days} days</li>
</ul>
</div>
<p style="text-align:center;color:#888;">{market} Quant Research v2.0 — Generated {datetime.now().strftime('%d-%m-%Y %H:%M:%S')}</p>
</body></html>"""

    path = os.path.join(save_dir, f"report_{today}.html")
    with open(path, 'w', encoding='utf-8') as f:
        f.write(html)
    return path
