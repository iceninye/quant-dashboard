#!/usr/bin/env python3
"""重試 Obsidian 寫入（2026-10-17 PMFX）— 只讀本地報告 + 寫 Vault，唔碰其他嘢。"""
import os, sys, logging
sys.path.insert(0, "/home/wsluser/hermes-projects")
sys.path.insert(0, "/home/wsluser/hermes-projects/sentinel-pmfx")

# 載入 .env（唔 print 值）
env_path = os.path.expanduser("~/.hermes/.env")
if os.path.exists(env_path):
    for line in open(env_path, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line: continue
        k, v = line.split("=", 1)
        v = v.strip().strip('"').strip("'")
        os.environ.setdefault(k.strip(), v)

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
from report_deployer import _obsidian_write_summary

summary = os.path.expanduser("/home/wsluser/hermes-projects/sentinel-pmfx/reports/17-10-2026/reports/summary_17-10-2026.md")
print("summary 存在:", os.path.exists(summary), "| 大小:", os.path.getsize(summary) if os.path.exists(summary) else 0)
ok = _obsidian_write_summary(
    system="pmfx",
    today="2026-10-17",
    summary_md_path=summary,
    extra_metadata={"cron_job_id": "2be814142adc", "schedule": "15 7 * * 1-5", "retry": "manual-after-fix"},
    slot="morning",
)
print("結果:", "✅ 成功" if ok else "❌ 仍然失敗")
