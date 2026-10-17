"""
US Quant Research — core.py
合併 data_sources + simulators + backtest + vol_surface + reporting
"""

from __future__ import annotations
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

from config import HEADERS, FALLBACK_TICKERS, CFG

logger = logging.getLogger("USQuant")

# ─── 網絡重試（P3 修復 2026-10-17）──────────────────────
# 原本完全冇 retry：yfinance 429 / 連線閃斷 → 該標的當日直接失敗、靜默缺數。
# 3 次嘗試、指數退避 + jitter（2s → 20s 上限），最後一次失敗照樣 raise（行為同舊版一致）。
from tenacity import retry as _retry, stop_after_attempt, wait_exponential_jitter, before_sleep_log  # noqa: E402

YF_RETRY = dict(
    reraise=True,
    stop=stop_after_attempt(3),
    wait=wait_exponential_jitter(initial=2, max=20),
    before_sleep=before_sleep_log(logger, logging.WARNING),
)


# ════════════════════════════════════════
# 數據源
# ════════════════════════════════════════


def get_risk_free_rate(fallback: float = 0.04) -> float:
    """US 10Y Treasury → fallback"""
    try:
        tnx = yf.Ticker("^TNX")
        hist = tnx.history(period="5d")
        if not hist.empty:
            rate = float(hist["Close"].iloc[-1]) / 100.0
            logger.info(f"✅ US 10Y Treasury: {rate:.2%}")
            return rate
    except Exception:
        pass
    logger.info(f"⚠️ Using fallback risk-free rate: {fallback:.2%}")
    return fallback


def fetch_top_tickers_yahoo() -> Optional[List[str]]:
    try:
        url = "https://finance.yahoo.com/markets/stocks/most-active/?start=0&count=100"
        tables = pd.read_html(url)
        if tables:
            df = tables[0]
            if "Symbol" in df.columns:
                tickers = df["Symbol"].tolist()
                logger.info(f"✅ Yahoo: {len(tickers)} tickers")
                return tickers
    except Exception as e:
        logger.warning(f"⚠️ Yahoo scraping failed: {e}")
    return None


def fetch_top_tickers_finviz() -> Optional[List[str]]:
    try:
        url = "https://finviz.com/screener.ashx?v=111&f=cap_large,sh_avgvol_o500&o=-volume"
        tables = pd.read_html(url, headers=HEADERS)
        for tbl in tables:
            if "Ticker" in tbl.columns:
                tickers = tbl["Ticker"].tolist()[:100]
                logger.info(f"✅ Finviz: {len(tickers)} tickers")
                return tickers
    except Exception as e:
        logger.warning(f"⚠️ Finviz scraping failed: {e}")
    return None


def fetch_finviz_fundamentals(tickers: List[str]) -> pd.DataFrame:
    rows = []
    for i in range(0, len(tickers), 20):
        batch = tickers[i:i+20]
        try:
            url = f"https://finviz.com/screener.ashx?v=152&t={','.join(batch)}"
            tables = pd.read_html(url, headers=HEADERS)
            for tbl in tables:
                if "Ticker" in tbl.columns:
                    rows.append(tbl)
                    break
        except Exception:
            pass
    if rows:
        df = pd.concat(rows, ignore_index=True)
        logger.info(f"✅ Finviz fundamentals: {len(df)} stocks")
        return df
    return pd.DataFrame()


def get_tickers(no_scrape: bool, fallback: List[str], top_n: int) -> List[str]:
    MIN_TICKERS = 95
    if no_scrape:
        logger.info(f"Using fallback: {len(fallback)} tickers")
        return fallback[:top_n]
    tickers = fetch_top_tickers_yahoo() or fetch_top_tickers_finviz()
    if not tickers:
        logger.info(f"All scraping failed, using fallback: {len(fallback)} tickers")
        tickers = fallback
    valid = [t for t in tickers if isinstance(t, str) and len(t) <= 5 and not t.isdigit()]
    if len(valid) < MIN_TICKERS:
        logger.warning(f"⚠️ Scraping only returned {len(valid)} tickers (min={MIN_TICKERS}), forcing fallback")
        valid = [t for t in fallback if isinstance(t, str) and len(t) <= 5 and not t.isdigit()]
    return valid[:top_n]


@_retry(**YF_RETRY)
def _fetch_history_retry(ticker: str, period: str = "2y") -> "pd.DataFrame":
    """單一 ticker 歷史價；空結果當失敗 → 觸發 retry（P3）。"""
    tkr = yf.Ticker(ticker)
    df = tkr.history(period=period)
    if df is None or df.empty:
        raise ValueError(f"empty history: {ticker}")
    return df


def download_price_data(tickers: List[str]) -> Dict[str, pd.DataFrame]:
    import time
    import random
    data = {}
    failed = []
    for i, ticker in enumerate(tickers):
        if i > 0:
            delay = random.uniform(0.5, 1.5)
            time.sleep(delay)
        try:
            df = _fetch_history_retry(ticker, "2y")
            if isinstance(df.columns, pd.MultiIndex):
                df.columns = [c[0] if isinstance(c, tuple) else c for c in df.columns]
            data[ticker] = df
        except Exception:
            failed.append(ticker)
    logger.info(f"Downloaded: {len(data)}/{len(tickers)}, failed: {len(failed)}")
    if failed:
        logger.info(f"Failed: {failed[:10]}...")
    return data


def fetch_option_chain(ticker: str) -> Optional[pd.DataFrame]:
    try:
        tkr = yf.Ticker(ticker)
        exps = list(tkr.options)
        if not exps:
            return None
        frames = []
        for exp in exps[:6]:
            try:
                chain = tkr.option_chain(exp)
                calls = chain.calls.copy()
                puts = chain.puts.copy()
                calls['type'] = 'CALL'
                puts['type'] = 'PUT'
                calls['expiration'] = exp
                puts['expiration'] = exp
                frames.append(pd.concat([calls, puts], ignore_index=True))
            except Exception:
                continue
        if frames:
            df = pd.concat(frames, ignore_index=True)
            try:
                price = float(tkr.history(period="5d")['Close'].iloc[-1])
                df['underlier_price'] = price
            except Exception:
                pass
            return df
    except Exception as e:
        logger.warning(f"Option chain failed for {ticker}: {e}")
    return None


# ════════════════════════════════════════
# 模擬器
# ════════════════════════════════════════

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


MIN_OBS = 20  # 【P6 2026-10-17】少於此觀測數 → 指標無意義，回傳 NaN


def _downside_deviation(excess: pd.Series) -> float:
    """【P5 2026-10-17】標準 downside deviation（Sortino 1994）。

    DD = sqrt( mean( min(r - MAR, 0)^2 ) )，分母用【全部觀測數】。
    舊寫法 downside.std() 只用下行子集嘅標準差，會系統性低估 DD → Sortino 偏大。
    """
    if excess.empty:
        return 0.0
    neg = np.minimum(excess.to_numpy(dtype=float), 0.0)
    return float(np.sqrt(np.mean(neg ** 2)))


def calc_sharpe(returns: pd.Series, rf: float) -> float:
    r = returns.dropna()
    if r.size < MIN_OBS or r.std() == 0:
        return np.nan
    return (r.mean() * 252 - rf) / (r.std() * np.sqrt(252))


def calc_sortino(returns: pd.Series, rf: float) -> float:
    r = returns.dropna()
    if r.size < MIN_OBS:
        return np.nan
    daily_rf = rf / 252
    excess = r - daily_rf
    dd = _downside_deviation(excess)
    if dd == 0:
        return np.nan
    return (excess.mean() * 252) / (dd * np.sqrt(252))


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
        if ret.size < MIN_OBS:  # 【P6】樣本不足 → 唔計指標，避免 2 個觀測出 Sharpe
            nan = float("nan")
            return {"total_return": nan, "cagr": nan, "volatility": nan, "sharpe": nan,
                    "sortino": nan, "calmar": nan, "max_drawdown": nan}
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
        # 【P5】標準 downside deviation（分母用全部觀測），唔再係下行子集嘅 std
        _dd = _downside_deviation(excess)
        sortino = (excess.mean() * freq) / (_dd * math.sqrt(freq) + 1e-12) if _dd > 0 else float("nan")
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
                       price_label: str = "Price ($)") -> Optional[str]:
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


def generate_vol_surface(ticker: str, options_df: pd.DataFrame, save_dir: str) -> Optional[str]:
    try:
        df = options_df.copy()
        if 'strike' not in df.columns or 'impliedVolatility' not in df.columns:
            return None
        df['days_to_exp'] = (pd.to_datetime(df['expiration']) - pd.Timestamp.today()).dt.days.clip(lower=1)
        if 'underlier_price' in df.columns:
            df['moneyness'] = df['strike'] / df['underlier_price']
        else:
            df['moneyness'] = df['strike'] / df['strike'].median()
        df = df[(df['impliedVolatility'] > 0.01) & (df['impliedVolatility'] < 3.0)]
        df = df.dropna(subset=['moneyness', 'days_to_exp', 'impliedVolatility'])
        if len(df) < 10:
            return None
        x = np.linspace(df['days_to_exp'].min(), df['days_to_exp'].max(), 40)
        y = np.linspace(df['moneyness'].min(), df['moneyness'].max(), 40)
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
        fig = go.Figure(data=[go.Surface(x=xx, y=yy, z=zz, colorscale='Viridis')])
        fig.update_layout(
            title=f"Implied Volatility Surface — {ticker}",
            scene=dict(xaxis_title='Days to Expiry', yaxis_title='Moneyness', zaxis_title='IV'),
        )
        path = os.path.join(save_dir, f"vol_surface_{ticker.replace('.', '_')}.png")
        fig.write_image(path, width=1200, height=800)
        return path
    except Exception as e:
        logger.warning(f"Plotly vol surface failed for {ticker}, falling back to matplotlib scatter: {e}")
        # Fallback: scatter plot via matplotlib (kaleido requires Chrome)
        try:
            import matplotlib
            matplotlib.use('Agg')
            import matplotlib.pyplot as plt
            df_clean = options_df.copy()
            if 'strike' not in df_clean.columns or 'impliedVolatility' not in df_clean.columns:
                return None
            df_clean['days_to_exp'] = (pd.to_datetime(df_clean['expiration']) - pd.Timestamp.today()).dt.days.clip(lower=1)
            if 'underlier_price' in df_clean.columns:
                df_clean['moneyness'] = df_clean['strike'] / df_clean['underlier_price']
            else:
                df_clean['moneyness'] = df_clean['strike'] / df_clean['strike'].median()
            df_clean = df_clean[(df_clean['impliedVolatility'] > 0.01) & (df_clean['impliedVolatility'] < 3.0)].dropna(subset=['moneyness', 'days_to_exp', 'impliedVolatility'])
            if len(df_clean) < 10:
                return None
            path = os.path.join(save_dir, f"vol_surface_{ticker.replace('.', '_')}.png")
            mpl_fig, ax = plt.subplots(figsize=(12, 8))
            sc = ax.scatter(df_clean['moneyness'], df_clean['days_to_exp'], c=df_clean['impliedVolatility'],
                            cmap='viridis', s=20, alpha=0.7)
            ax.set_title(f"Implied Volatility — {ticker} (2D projection)")
            ax.set_xlabel("Moneyness (Strike / Underlier)")
            ax.set_ylabel("Days to Expiry")
            plt.colorbar(sc, ax=ax, label='Implied Volatility')
            mpl_fig.tight_layout()
            mpl_fig.savefig(path, dpi=80)
            plt.close(mpl_fig)
            return path
        except Exception as mpl_e:
            logger.warning(f"Matplotlib vol surface also failed for {ticker}: {mpl_e}")
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
                         market: str = "US", price_unit: str = "$",
                         lookback_days: int = 252) -> str:
    html = f"""<!DOCTYPE html>
<html lang="en">
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
<li>Risk-Free Rate: {summary.get('risk_free_rate', 0):.2%} (US 10Y Treasury)</li>
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
