"""
Sentinel Unified v4.0 — Core Computation Layer
數據下載、宏觀指標、風險計算、分級、行動建議、相關性分析
"""

import logging
import warnings
from typing import Dict, List
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
import requests
import yfinance as yf

from config import (
    ALL_ASSET_TICKERS, ALL_TICKERS, MACRO_TICKERS,
    WATCHLIST, DISPLAY_NAMES, SECTOR_MAP, HEADERS,
    RISK_FREE_RATE_FALLBACK, RISK_THRESHOLDS, FEAR_GREED_LABELS,
)

warnings.filterwarnings("ignore")
logger = logging.getLogger("Sentinel.core")

# ─── 網絡重試（P3 修復 2026-10-17）──────────────────────
from tenacity import retry as _retry, stop_after_attempt, wait_exponential_jitter, before_sleep_log  # noqa: E402

YF_RETRY = dict(
    reraise=True,
    stop=stop_after_attempt(3),
    wait=wait_exponential_jitter(initial=2, max=20),
    before_sleep=before_sleep_log(logger, logging.WARNING),
)


# ──────────────────────────────────────
# 數據下載
# ──────────────────────────────────────

@_retry(**YF_RETRY)
def _bulk_download_retry(period: str) -> pd.DataFrame:
    """Bulk download；失敗/空結果 → tenacity retry（P3）。"""
    d = yf.download(ALL_TICKERS, period=period, progress=False, threads=False)
    if d is None or len(d) == 0:
        raise ValueError("empty bulk download")
    return d


def download_data(period: str = "1y") -> pd.DataFrame:
    """Bulk download all tickers"""
    logger.info(f"下載 {len(ALL_TICKERS)} 個標的 ({period})...")
    data = _bulk_download_retry(period)
    # Use Adj Close for accuracy with dividend-paying assets
    if "Adj Close" in data.columns.get_level_values(0):
        data = data["Adj Close"]
    else:
        data = data["Close"]
    data = data.ffill().dropna(how="all")
    logger.info(f"✅ 數據下載完成：{data.shape[0]} 天 × {data.shape[1]} 標的")
    return data


# ──────────────────────────────────────
# 宏觀指標
# ──────────────────────────────────────

def fetch_macro(data: pd.DataFrame) -> dict:
    """從已下載數據提取宏觀指標"""
    latest = data.iloc[-1]

    macro = {
        "vix": None, "vix_change": None,
        "tnx": None, "rf_rate": RISK_FREE_RATE_FALLBACK,
        "dxy": None, "dxy_change": None,
        "cg_ratio": None,
        "fear_greed": None, "fear_greed_label": None,
    }

    # VIX
    if "^VIX" in data.columns and pd.notna(latest.get("^VIX")):
        macro["vix"] = round(float(latest["^VIX"]), 2)
        if len(data) >= 2 and pd.notna(data["^VIX"].iloc[-2]):
            prev = float(data["^VIX"].iloc[-2])
            if prev != 0:
                macro["vix_change"] = round((macro["vix"] - prev) / prev * 100, 2)

    # US 10Y
    if "^TNX" in data.columns and pd.notna(latest.get("^TNX")):
        macro["tnx"] = round(float(latest["^TNX"]), 2)
        macro["rf_rate"] = float(latest["^TNX"]) / 100

    # DXY
    if "DX-Y.NYB" in data.columns and pd.notna(latest.get("DX-Y.NYB")):
        macro["dxy"] = round(float(latest["DX-Y.NYB"]), 2)
        if len(data) >= 2 and pd.notna(data["DX-Y.NYB"].iloc[-2]):
            prev = float(data["DX-Y.NYB"].iloc[-2])
            if prev != 0:
                macro["dxy_change"] = round((macro["dxy"] - prev) / prev * 100, 2)

    # Copper/Gold Ratio (HG=F $/lb ÷ GC=F $/oz)
    if ("HG=F" in data.columns and "GC=F" in data.columns):
        cg = data["HG=F"] / data["GC=F"]
        cg = cg.dropna()
        if len(cg) > 0:
            macro["cg_ratio"] = round(float(cg.iloc[-1]), 6)

    # Fear & Greed (CNN API)
    try:
        resp = requests.get(
            "https://production.dataviz.cnn.io/index/fearandgreed/graphdata",
            headers=HEADERS, timeout=10,
        )
        if resp.status_code == 200:
            fg_data = resp.json().get("fear_and_greed", {})
            if "score" in fg_data:
                score = float(fg_data["score"])
                macro["fear_greed"] = round(score, 0)
                for (lo, hi), label in FEAR_GREED_LABELS.items():
                    if lo < score <= hi:
                        macro["fear_greed_label"] = label
                        break
    except Exception as e:
        logger.warning(f"Fear & Greed 抓取失敗: {e}")

    return macro


# ──────────────────────────────────────
# 資產指標計算（統一公式）
# ──────────────────────────────────────

def calculate_mdd(prices: pd.Series) -> float:
    """Peak-to-trough max drawdown on price/equity series"""
    rolling_max = prices.cummax()
    drawdown = prices / rolling_max - 1.0
    return float(drawdown.min())


def calculate_metrics(data: pd.DataFrame, rf_rate: float) -> pd.DataFrame:
    """計算所有資產指標（統一公式規格）"""
    # Forward-fill before pct_change to handle cross-market calendar gaps (HK vs US)
    filled = data[ALL_ASSET_TICKERS].ffill()
    daily_returns = filled.pct_change().dropna(how="all")
    metrics_list = []

    for ticker in ALL_ASSET_TICKERS:
        if ticker not in data.columns:
            continue
        ret = daily_returns[ticker].dropna()
        if len(ret) < 30:
            continue

        prices = filled[ticker].dropna()
        if len(prices) < 2:
            continue

        # CAGR: 統一用日期差推年化 (end/start)^(365/days) - 1
        n_calendar_days = (prices.index[-1] - prices.index[0]).days
        if n_calendar_days <= 0:
            cagr = 0.0
        else:
            cagr = float((prices.iloc[-1] / prices.iloc[0]) ** (365.0 / n_calendar_days) - 1)

        # Volatility: 日報酬標準差 × √252
        volatility = float(ret.std() * np.sqrt(252))

        # Sharpe: (mean_daily × 252 - rf) / (std_daily × √252)
        sharpe = float((ret.mean() * 252 - rf_rate) / volatility) if volatility > 0 else 0

        # MDD: peak-to-trough on price series
        mdd = calculate_mdd(prices)

        # Sortino: 年化超額報酬 / 下行波動
        daily_rf = rf_rate / 252
        excess = ret - daily_rf
        downside = excess[excess < 0]
        if len(downside) > 0 and downside.std() > 0:
            sortino = float((excess.mean() * 252) / (downside.std() * np.sqrt(252)))
        else:
            sortino = 0.0

        # Calmar: 年化報酬 / 最大回撤
        calmar = float(cagr / abs(mdd)) if mdd != 0 else 0.0

        # Daily / Week / Month returns
        daily_ret = float(ret.iloc[-1]) if len(ret) >= 1 else 0
        cum_return = (1 + ret).cumprod()
        week_ret = float(cum_return.iloc[-1] / cum_return.iloc[-5] - 1) if len(cum_return) >= 5 else 0
        month_ret = float(cum_return.iloc[-1] / cum_return.iloc[-22] - 1) if len(cum_return) >= 22 else 0

        # Beta (vs SPY or 2800.HK)
        benchmark = "SPY" if "SPY" in daily_returns.columns else "2800.HK"
        beta = 1.0
        if benchmark in daily_returns.columns and ticker != benchmark:
            aligned = pd.concat(
                [ret, daily_returns[benchmark]], axis=1
            ).dropna()  # Align by date index for cross-market accuracy
            if len(aligned) >= 30:
                cov = np.cov(aligned.iloc[:, 0].values, aligned.iloc[:, 1].values)
                beta = float(cov[0, 1] / cov[1, 1]) if cov[1, 1] != 0 else 1.0

        # VaR 95%: return distribution 5th percentile
        var_95 = float(ret.quantile(0.05))

        # CVaR 95%: mean of returns below VaR
        cvar_95 = float(ret[ret <= var_95].mean()) if len(ret[ret <= var_95]) > 0 else var_95

        # Market classification
        if ticker.endswith(".HK") and ticker not in WATCHLIST.get("替代資產", []):
            market = "港股"
        elif ticker in WATCHLIST.get("ETF", []):
            market = "ETF"
        elif ticker in WATCHLIST.get("替代資產", []):
            market = "替代資產"
        else:
            market = "美股"

        metrics_list.append({
            "ticker": ticker,
            "name": DISPLAY_NAMES.get(ticker, ticker),
            "sector": SECTOR_MAP.get(ticker, "—"),
            "market": market,
            "cagr": cagr,
            "volatility": volatility,
            "sharpe": sharpe,
            "sortino": sortino,
            "calmar": calmar,
            "max_drawdown": mdd,
            "daily_return": daily_ret,
            "week_return": week_ret,
            "month_return": month_ret,
            "beta": round(beta, 2),
            "var_95": var_95,
            "cvar_95": cvar_95,
        })

    return pd.DataFrame(metrics_list)


# ──────────────────────────────────────
# 風險分級
# ──────────────────────────────────────

@dataclass
class RiskClassification:
    level: str
    emoji: str
    label: str
    score: int = 0
    reasons: List[str] = field(default_factory=list)


def classify_risk(row: pd.Series, vol_q90: float, vol_q50: float) -> RiskClassification:
    score = 0
    reasons = []

    vol = row.get("volatility", 0)
    if not np.isnan(vol):
        if vol > vol_q90:
            score += 3
            reasons.append(f"波動率 {vol:.1%} 超過 90th")
        elif vol > vol_q50:
            score += 1
            reasons.append(f"波動率 {vol:.1%} 中等偏高")

    sharpe = row.get("sharpe", 0)
    if not np.isnan(sharpe):
        if sharpe < -1:
            score += 2
            reasons.append(f"Sharpe {sharpe:.2f} 極差")
        elif sharpe < 0:
            score += 1
            reasons.append(f"Sharpe {sharpe:.2f} 負值")

    mdd = row.get("max_drawdown", 0)
    if not np.isnan(mdd):
        if mdd < -0.30:
            score += 2
            reasons.append(f"最大回撤 {mdd:.1%}")
        elif mdd < -0.15:
            score += 1
            reasons.append(f"最大回撤 {mdd:.1%}")

    daily_ret = row.get("daily_return", 0)
    if not np.isnan(daily_ret):
        if daily_ret < -0.05:
            score += 2
            reasons.append(f"日跌 {daily_ret:.1%}")
        elif daily_ret < -0.03:
            score += 1
            reasons.append(f"日跌 {daily_ret:.1%}")

    beta = row.get("beta", 1)
    if not np.isnan(beta) and beta > 1.5:
        score += 1
        reasons.append(f"高 Beta {beta:.2f}")

    var = row.get("var_95", 0)
    if not np.isnan(var) and var < -0.04:
        score += 1
        reasons.append(f"VaR {var:.1%}")

    if score >= 4:
        return RiskClassification("red", "🔴", "極高風險", score, reasons)
    elif score >= 2:
        return RiskClassification("orange", "🟠", "注意", score, reasons)
    else:
        return RiskClassification("green", "🟢", "相對安全", score, reasons)


# ──────────────────────────────────────
# 投資行動建議
# ──────────────────────────────────────

def generate_action(row: pd.Series, rc: RiskClassification, macro: dict) -> dict:
    """生成投資行動建議"""
    vix = macro.get("vix")
    if vix and vix >= 30:
        sentiment_penalty = 2  # High panic
    elif vix and vix >= 20:
        sentiment_penalty = 1  # Elevated caution
    else:
        sentiment_penalty = 0

    if rc.level == "red":
        return {"action": "強烈減持", "emoji": "🔴", "priority": 3 + sentiment_penalty}
    elif rc.level == "orange":
        sharpe = row.get("sharpe", 0)
        week_ret = row.get("week_return", 0)
        if not np.isnan(sharpe) and sharpe > 0.5 and (not np.isnan(week_ret) and week_ret > 0):
            return {"action": "觀望", "emoji": "⏸️", "priority": 1}
        return {"action": "建議減持", "emoji": "🟠", "priority": 2}
    else:
        sharpe = row.get("sharpe", 0)
        cagr = row.get("cagr", 0)
        if not np.isnan(sharpe) and sharpe > 1.0 and not np.isnan(cagr) and cagr > 0.1:
            return {"action": "可加倉", "emoji": "✅", "priority": 0}
        return {"action": "觀望", "emoji": "⏸️", "priority": 1}


# ──────────────────────────────────────
# 相關性分析
# ──────────────────────────────────────

def analyze_correlations(data: pd.DataFrame, threshold: float = 0.8) -> List[dict]:
    """高相關性警告"""
    filled = data[ALL_ASSET_TICKERS].ffill()
    daily_returns = filled.pct_change().dropna(how="all")
    corr = daily_returns.corr()

    pairs = []
    for i in range(len(corr.columns)):
        for j in range(i + 1, len(corr.columns)):
            val = corr.iloc[i, j]
            if abs(val) >= threshold:
                t1, t2 = corr.columns[i], corr.columns[j]
                pairs.append({
                    "pair": f"{DISPLAY_NAMES.get(t1, t1)} & {DISPLAY_NAMES.get(t2, t2)}",
                    "corr": round(val, 2),
                })
    return sorted(pairs, key=lambda x: abs(x["corr"]), reverse=True)


# ──────────────────────────────────────
# 本週重點關注
# ──────────────────────────────────────

def pick_focus(metrics_df: pd.DataFrame, rc_map: Dict[str, RiskClassification]) -> List[dict]:
    focus = []
    non_etf = metrics_df[metrics_df["market"] != "ETF"]

    # 最高波動率 Top 2
    for _, row in non_etf.nlargest(2, "volatility").iterrows():
        t = row["ticker"]
        rc = rc_map.get(t)
        focus.append({
            "ticker": t, "name": row["name"],
            "reason": f"波動率最高 {row['volatility']:.1%}",
            "risk": rc.level if rc else "orange",
            "emoji": rc.emoji if rc else "🟠",
        })

    # 最大日跌幅 Top 1
    for _, row in non_etf.nsmallest(1, "daily_return").iterrows():
        t = row["ticker"]
        if t not in [f["ticker"] for f in focus]:
            rc = rc_map.get(t)
            focus.append({
                "ticker": t, "name": row["name"],
                "reason": f"日跌幅最大 {row['daily_return']:.1%}",
                "risk": rc.level if rc else "orange",
                "emoji": rc.emoji if rc else "🟠",
            })

    # 最佳 Sharpe Top 1
    best = non_etf[non_etf["sharpe"] > 0].nlargest(1, "sharpe")
    for _, row in best.iterrows():
        t = row["ticker"]
        if t not in [f["ticker"] for f in focus]:
            focus.append({
                "ticker": t, "name": row["name"],
                "reason": f"Sharpe 最佳 {row['sharpe']:.2f}",
                "risk": "green", "emoji": "🟢",
            })

    # 月度動能最強（Month Return Top 1 with Sharpe > 0.5）
    momentum = non_etf[(non_etf["month_return"] > 0) & (non_etf["sharpe"] > 0.5)]
    for _, row in momentum.nlargest(1, "month_return").iterrows():
        t = row["ticker"]
        if t not in [f["ticker"] for f in focus]:
            focus.append({
                "ticker": t, "name": row["name"],
                "reason": f"月度動能最強 {row['month_return']:.1%}（Sharpe {row['sharpe']:.2f}）",
                "risk": "green", "emoji": "🚀",
            })

    return focus
