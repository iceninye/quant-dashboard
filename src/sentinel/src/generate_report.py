#!/usr/bin/env python3
"""
Sentinel Unified v4.0 — Report Generation & Orchestration
純 HTML+CSS，零 JavaScript，零 CDN 依賴

架構: config.py (常數) → core.py (計算) → generate_report.py (報告 + orchestration)
"""

import os
import sys
import logging
import warnings
from datetime import datetime
from typing import Dict, List

# 確保可以 import 共用 report_deployer
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))

import numpy as np
import pandas as pd
from jinja2 import Environment, FileSystemLoader

from config import (
    BASE_DIR, DATA_DIR, REPORT_DIR, TEMPLATE_DIR,
    DISPLAY_NAMES, RISK_FREE_RATE_FALLBACK,
)
from core import (
    download_data, fetch_macro, calculate_metrics, classify_risk,
    generate_action, analyze_correlations, pick_focus,
    RiskClassification,
)

warnings.filterwarnings("ignore")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("Sentinel")


# ──────────────────────────────────────
# 報告生成
# ──────────────────────────────────────

def generate_reports(metrics_df: pd.DataFrame, macro: dict, rc_map: Dict[str, RiskClassification],
                     focus: List[dict], corr_pairs: List[dict], today: str) -> dict:
    """生成 HTML + CSV + Markdown 報告"""
    date_dir = os.path.join(REPORT_DIR, today)
    os.makedirs(date_dir, exist_ok=True)

    # ── HTML (Jinja2) ──
    env = Environment(loader=FileSystemLoader(TEMPLATE_DIR))
    template = env.get_template("report_template.html")

    # Prepare template data
    metrics_list = []
    for _, row in metrics_df.sort_values("volatility", ascending=False).iterrows():
        t = row["ticker"]
        rc = rc_map.get(t, RiskClassification("green", "🟢", "—"))
        action = generate_action(row, rc, macro)
        metrics_list.append({
            "ticker": t,
            "name": row["name"],
            "sector": row["sector"],
            "market": row["market"],
            "cagr": round(row["cagr"] * 100, 2),
            "volatility": round(row["volatility"] * 100, 2),
            "sharpe": round(row["sharpe"], 2),
            "sortino": round(row.get("sortino", 0), 2),
            "calmar": round(row.get("calmar", 0), 2),
            "mdd": round(row["max_drawdown"] * 100, 2),
            "daily_return": round(row["daily_return"] * 100, 2),
            "week_return": round(row.get("week_return", 0) * 100, 2),
            "month_return": round(row.get("month_return", 0) * 100, 2),
            "beta": row["beta"],
            "var_95": round(row["var_95"] * 100, 2),
            "cvar_95": round(row.get("cvar_95", row["var_95"]) * 100, 2),
            "risk_level": rc.level,
            "risk_emoji": rc.emoji,
            "risk_label": rc.label,
            "risk_reasons": rc.reasons,
            "action": action["action"],
            "action_emoji": action["emoji"],
        })

    # KPI summary
    buy_count = sum(1 for m in metrics_list if m["action"] == "可加倉")
    sell_count = sum(1 for m in metrics_list if m["action"] in ("強烈減持", "建議減持"))
    watch_count = sum(1 for m in metrics_list if m["action"] == "觀望")
    avg_sharpe = round(np.mean([m["sharpe"] for m in metrics_list]), 2) if metrics_list else 0
    win_rate = round(sum(1 for m in metrics_list if m["sharpe"] > 0) / len(metrics_list) * 100, 1) if metrics_list else 0

    # VIX color
    vix = macro.get("vix")
    if vix:
        if vix >= 30:
            macro["vix_color"] = "#dc2626"
            macro["vix_label"] = "高恐慌"
        elif vix >= 20:
            macro["vix_color"] = "#f59e0b"
            macro["vix_label"] = "偏高"
        else:
            macro["vix_color"] = "#16a34a"
            macro["vix_label"] = "平穩"

    # DXY color
    dxy_chg = macro.get("dxy_change")
    if dxy_chg is not None:
        macro["dxy_color"] = "#16a34a" if dxy_chg >= 0 else "#dc2626"

    # CG ratio interpretation (standard: $/lb ÷ $/oz)
    cg = macro.get("cg_ratio")
    if cg:
        if cg > 0.0045:
            macro["cg_label"] = "經濟擴張"
            macro["cg_color"] = "#16a34a"
        elif cg > 0.0030:
            macro["cg_label"] = "中性"
            macro["cg_color"] = "#f59e0b"
        else:
            macro["cg_label"] = "避險升溫"
            macro["cg_color"] = "#dc2626"

    html_output = template.render(
        report_date=today,
        report_time=datetime.now().strftime("%H:%M"),
        macro=macro,
        kpi={
            "total": len(metrics_list),
            "buy": buy_count,
            "sell": sell_count,
            "watch": watch_count,
            "avg_sharpe": avg_sharpe,
            "win_rate": win_rate,
        },
        metrics=metrics_list,
        warnings=corr_pairs,
        focus=focus,
    )

    html_path = os.path.join(date_dir, f"dashboard_{today}.html")
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html_output)
    logger.info(f"✅ HTML: {html_path} ({os.path.getsize(html_path):,} bytes)")

    # ── CSV ──
    csv_path = os.path.join(date_dir, f"signals_{today}.csv")
    export_df = metrics_df.copy()
    export_df["risk_level"] = export_df["ticker"].map(lambda t: rc_map.get(t, RiskClassification("green", "🟢", "—")).level)
    export_df["risk_label"] = export_df["ticker"].map(lambda t: rc_map.get(t, RiskClassification("green", "🟢", "—")).emoji)
    export_df["risk_level_text"] = export_df["ticker"].map(lambda t: rc_map.get(t, RiskClassification("green", "🟢", "—")).label)
    export_df["action"] = export_df.apply(lambda r: generate_action(r, rc_map.get(r["ticker"], RiskClassification("green", "🟢", "—")), macro)["action"], axis=1)
    export_df.to_csv(csv_path, index=False, encoding="utf-8-sig")
    logger.info(f"✅ CSV: {csv_path}")

    # ── Markdown ──
    md_lines = [f"# Sentinel 市場監控報告 — {today}\n"]
    md_lines.append(f"## 📊 宏觀指標\n")
    if macro.get("vix"):
        md_lines.append(f"- **VIX**: {macro['vix']} ({macro.get('vix_label', '—')})")
    if macro.get("dxy"):
        md_lines.append(f"- **DXY**: {macro['dxy']}")
    if macro.get("tnx"):
        md_lines.append(f"- **US 10Y**: {macro['tnx']}%")
    if macro.get("cg_ratio"):
        md_lines.append(f"- **銅金比**: {macro['cg_ratio']} ({macro.get('cg_label', '—')})")
    if macro.get("fear_greed"):
        md_lines.append(f"- **Fear & Greed**: {macro['fear_greed']:.0f} ({macro.get('fear_greed_label', '—')})")

    md_lines.append(f"\n## 📈 KPI\n")
    md_lines.append(f"- 標的: {len(metrics_list)} | 買: {buy_count} | 沽: {sell_count} | 觀望: {watch_count}")
    md_lines.append(f"- 平均 Sharpe: {avg_sharpe} | 勝率: {win_rate}%")

    md_lines.append(f"\n## ⚠️ 行動建議\n")
    for m in sorted(metrics_list, key=lambda x: {"強烈減持": 0, "建議減持": 1, "觀望": 2, "可加倉": 3}.get(x["action"], 4)):
        md_lines.append(f"- {m['action_emoji']} **{m['name']}** ({m['ticker']}): {m['action']} | Sharpe {m['sharpe']} | Vol {m['volatility']:.1f}%")

    if corr_pairs:
        md_lines.append(f"\n## 🔗 高相關性警告\n")
        for p in corr_pairs:
            md_lines.append(f"- {p['pair']}: {p['corr']}")

    if focus:
        md_lines.append(f"\n## 🔍 本週重點\n")
        for f in focus:
            md_lines.append(f"- {f['emoji']} **{f['name']}** ({f['ticker']}): {f['reason']}")

    md_path = os.path.join(date_dir, f"summary_{today}.md")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write("\n".join(md_lines))
    logger.info(f"✅ MD: {md_path}")

    return {
        "html": html_path,
        "csv": csv_path,
        "md": md_path,
        "buy": buy_count,
        "sell": sell_count,
        "watch": watch_count,
        "total": len(metrics_list),
    }


# ──────────────────────────────────────
# 主流程
# ──────────────────────────────────────

def run():
    today = datetime.now().strftime("%d-%m-%Y")
    logger.info(f"═══ Sentinel Unified v4.0 — {today} ═══")

    # 1. 下載數據
    data = download_data()

    # 2. 宏觀指標
    macro = fetch_macro(data)
    logger.info(f"VIX: {macro.get('vix')} | DXY: {macro.get('dxy')} | 10Y: {macro.get('tnx')}% | 銅金比: {macro.get('cg_ratio')}")

    # 3. 計算指標
    metrics_df = calculate_metrics(data, macro.get("rf_rate", RISK_FREE_RATE_FALLBACK))
    logger.info(f"✅ 計算完成：{len(metrics_df)} 個標的")

    # 4. 風險分級
    vol_q90 = metrics_df["volatility"].quantile(0.9)
    vol_q50 = metrics_df["volatility"].quantile(0.5)
    rc_map = {}
    for _, row in metrics_df.iterrows():
        rc_map[row["ticker"]] = classify_risk(row, vol_q90, vol_q50)

    red = sum(1 for rc in rc_map.values() if rc.level == "red")
    orange = sum(1 for rc in rc_map.values() if rc.level == "orange")
    green = sum(1 for rc in rc_map.values() if rc.level == "green")
    logger.info(f"風險分級：🔴{red} 🟠{orange} 🟢{green}")

    # 5. 相關性分析
    corr_pairs = analyze_correlations(data)
    if corr_pairs:
        logger.info(f"⚠️ 高相關性警告：{len(corr_pairs)} 對")

    # 6. 重點關注
    focus = pick_focus(metrics_df, rc_map)

    # 7. 生成報告
    result = generate_reports(metrics_df, macro, rc_map, focus, corr_pairs, today)

    # 8. 保存 Excel
    xlsx_path = os.path.join(DATA_DIR, f"risk_monitor_{today}.xlsx")
    with pd.ExcelWriter(xlsx_path, engine="openpyxl") as writer:
        metrics_df.to_excel(writer, sheet_name="Metrics", index=False)
    logger.info(f"✅ XLSX: {xlsx_path}")

    logger.info(f"═══ 完成。買:{result['buy']} 沽:{result['sell']} 觀望:{result['watch']} ═══")

    # ── 自動部署到 ~/hermes reports/ ──
    try:
        from report_deployer import deploy_sentinel
        sentinel_charts_dir = os.path.join(BASE_DIR, "charts")
        deploy_sentinel(today, os.path.join(REPORT_DIR, today), DATA_DIR, sentinel_charts_dir)
        logger.info("✅ 已部署到 ~/hermes reports/")
    except Exception as e:
        logger.warning("⚠️ 部署失敗（不影響原報告）: %s", e)

    # ── Phase 6: Obsidian Vault write (failure-isolated) ──
    try:
        from report_deployer import _obsidian_write_summary, _date_dd_mm_to_iso
        _obsidian_write_summary(
            system="sentinel",
            today=_date_dd_mm_to_iso(today),  # convert dd-mm-YYYY → YYYY-MM-DD for Vault
            summary_md_path=result["md"],
            extra_metadata={
                "cron_job_id": "bf6c20c1bba2",
                "schedule": "15 8 * * 2,5",
            },
        )
    except Exception as e:
        logger.warning("⚠️ Obsidian write call failed (non-fatal): %s", e)

    return result


if __name__ == "__main__":
    run()
