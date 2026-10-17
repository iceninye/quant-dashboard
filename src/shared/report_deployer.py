"""
Shared Report Deployer — 統一報告部署到 ~/hermes reports/
所有模組共用，每次生成報告後自動：
1. 複製最新報告到 ~/hermes reports/ 根目錄（前綴區分模組）
2. 複製圖表到 ~/hermes reports/charts/
3. 歸檔上一份報告到 ~/hermes reports/archive/MM-YYYY/
"""

import os
import shutil
import logging
from datetime import datetime
from pathlib import Path

logger = logging.getLogger("ReportDeployer")

HERMES_REPORTS = Path.home() / "hermes reports"


def _ensure_dirs():
    for sub in ["charts", "archive", "raw"]:
        (HERMES_REPORTS / sub).mkdir(parents=True, exist_ok=True)


def _archive_previous(prefix: str, today: str):
    """將根目錄現有的同前綴檔案歸檔"""
    month_key = datetime.now().strftime("%Y-%m")
    archive_dir = HERMES_REPORTS / "archive" / month_key / prefix
    archive_dir.mkdir(parents=True, exist_ok=True)

    archived = 0
    for f in HERMES_REPORTS.iterdir():
        if f.is_file() and f.name.startswith(prefix + "-"):
            shutil.move(str(f), str(archive_dir / f.name))
            archived += 1

    # Archive charts
    charts_archive = HERMES_REPORTS / "archive" / month_key / f"{prefix}-charts"
    charts_dir = HERMES_REPORTS / "charts"
    if charts_dir.exists():
        for f in charts_dir.iterdir():
            if f.is_file() and f.name.startswith(prefix + "-"):
                charts_archive.mkdir(parents=True, exist_ok=True)
                shutil.move(str(f), str(charts_archive / f.name))
                archived += 1

    # Archive raw
    raw_dir = HERMES_REPORTS / "raw"
    raw_archive = HERMES_REPORTS / "archive" / month_key / f"{prefix}-raw"
    if raw_dir.exists():
        for f in raw_dir.iterdir():
            if f.is_file() and f.name.startswith(prefix + "-"):
                raw_archive.mkdir(parents=True, exist_ok=True)
                shutil.move(str(f), str(raw_archive / f.name))
                archived += 1

    if archived > 0:
        logger.info("📦 歸檔 %s: %d 個檔案 → archive/%s/%s/", prefix, archived, month_key, prefix)


def deploy_sentinel(today: str, report_dir: str, data_dir: str, charts_dir: str = None):
    """部署 Sentinel 報告"""
    _ensure_dirs()
    _archive_previous("sentinel", today)

    # Reports
    mapping = {
        f"dashboard_{today}.html": "sentinel-dashboard.html",
        f"summary_{today}.md": "sentinel-summary.md",
        f"signals_{today}.csv": "sentinel-signals.csv",
    }
    for src_name, dst_name in mapping.items():
        src = Path(report_dir) / src_name
        if src.exists():
            shutil.copy2(src, HERMES_REPORTS / dst_name)
            logger.info("  ✅ %s → %s", src_name, dst_name)

    # Data → raw/
    data_path = Path(data_dir)
    for f in data_path.glob(f"risk_monitor_{today}.*"):
        shutil.copy2(f, HERMES_REPORTS / "raw" / f"sentinel-{f.name}")

    # Charts
    if charts_dir and Path(charts_dir).exists():
        for f in Path(charts_dir).glob("*.png"):
            shutil.copy2(f, HERMES_REPORTS / "charts" / f"sentinel-{f.name}")


def deploy_pmfx(today: str, day_dir: str):
    """部署 PMFX 報告"""
    _ensure_dirs()
    _archive_previous("pmfx", today)

    day_path = Path(day_dir)

    # Reports
    mapping = {
        f"dashboard_{today}.html": "pmfx-dashboard.html",
        f"summary_{today}.md": "pmfx-summary.md",
        f"report_{today}.json": "pmfx-report.json",
    }
    for src_name, dst_name in mapping.items():
        src = day_path / "reports" / src_name
        if src.exists():
            shutil.copy2(src, HERMES_REPORTS / dst_name)
            logger.info("  ✅ %s → %s", src_name, dst_name)

    # Signals CSV
    sig = day_path / "data" / f"signals_{today}.csv"
    if sig.exists():
        shutil.copy2(sig, HERMES_REPORTS / "pmfx-signals.csv")

    # Raw data → raw/
    raw_src = day_path / "raw"
    if raw_src.exists():
        for f in raw_src.glob("*.csv"):
            shutil.copy2(f, HERMES_REPORTS / "raw" / f"pmfx-{f.name}")

    # Data CSVs → raw/
    data_src = day_path / "data"
    if data_src.exists():
        for f in data_src.glob("*.csv"):
            shutil.copy2(f, HERMES_REPORTS / "raw" / f"pmfx-{f.name}")


def deploy_quant(today: str, output_dir: str, prefix: str, charts_subdir: str = "charts"):
    """部署 Quant HK/US 報告"""
    _ensure_dirs()
    _archive_previous(prefix, today)

    out = Path(output_dir)

    # Summary
    summary = out / f"summary_{today}.md"
    if summary.exists():
        shutil.copy2(summary, HERMES_REPORTS / f"{prefix}-summary.md")
        logger.info("  ✅ summary → %s-summary.md", prefix)

    # XLSX → raw/
    xlsx = out / f"all_data_{today}.xlsx"
    if xlsx.exists():
        shutil.copy2(xlsx, HERMES_REPORTS / "raw" / f"{prefix}-all_data_{today}.xlsx")

    # Charts
    charts_path = out / charts_subdir
    if charts_path.exists():
        count = 0
        for f in charts_path.glob("*.png"):
            shutil.copy2(f, HERMES_REPORTS / "charts" / f"{prefix}-{f.name}")
            count += 1
        logger.info("  ✅ %s charts: %d files → charts/", prefix, count)


# ============================================================================
# Phase 6 — Obsidian integration (append-only, original functions unchanged)
# ============================================================================

def _obsidian_write_summary(system: str, today: str, summary_md_path: str,
                             extra_metadata: dict = None, slot: str = None) -> bool:
    """Phase 6 — Write canonical summary to Obsidian Vault.

    Failure-isolated: Obsidian failure NEVER fails the Quant run.
    All logging is at INFO/WARNING level. No API key leaked.
    """
    try:
        from obsidian_writer import write_quant_report
    except ImportError as e:
        logger.warning("obsidian_writer module not available (non-fatal): %s", e)
        return False

    try:
        result = write_quant_report(
            system=system,
            date_iso=today,
            summary_md_path=str(summary_md_path),
            extra_metadata=extra_metadata or {},
            slot=slot,
        )
        if result.get("status") == "ok":
            logger.info("✅ Obsidian write: %s → %s (%s)",
                       system, result.get("path"), result.get("action"))
            return True
        else:
            logger.warning("⚠️ Obsidian write failed (non-fatal): system=%s date=%s action=%s error=%s",
                          system, today, result.get("action"), result.get("error"))
            return False
    except Exception as e:
        logger.warning("⚠️ Obsidian write exception (non-fatal): %s", e)
        return False


def _date_iso_to_dd_mm(today_iso: str) -> str:
    """Convert ISO YYYY-MM-DD → dd-mm-YYYY for matching iCloud filename conventions."""
    try:
        y, m, d = today_iso.split("-")
        return f"{d}-{m}-{y}"
    except Exception:
        return today_iso


def _date_dd_mm_to_iso(today_dd_mm: str) -> str:
    """Convert dd-mm-YYYY → ISO YYYY-MM-DD for Obsidian Vault path."""
    try:
        d, m, y = today_dd_mm.split("-")
        return f"{y}-{m}-{d}"
    except Exception:
        return today_dd_mm
