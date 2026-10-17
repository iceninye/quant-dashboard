#!/usr/bin/env python3
"""Fix 6 驗證：金銀比唔再 nan（用 GC=F/SI=F）。只讀，唔寫任何 report。"""
import sys, pandas as pd
sys.path.insert(0, ".")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__)))) if False else None
import os
sys.path.insert(0, os.path.expanduser("~/hermes-projects"))
from src.core import download_history, cross_asset_summary, load_settings

s = load_settings("configs/config.yaml")
frames = []
for t in ["GC=F", "SI=F"]:
    h = download_history(t, period="1y", interval="1d")
    if h is not None and not h.empty:
        h = h.copy(); h["ticker"] = t; frames.append(h)
px = pd.concat(frames, ignore_index=True)
res = cross_asset_summary(px)
gsr = res.get("gold_silver_ratio")
print("金銀比:", gsr)
assert gsr, "❌ 金銀比仍然缺失"
assert isinstance(gsr["current"], float) and gsr["current"] > 0, "❌ current 唔係有效數字"
print(f"✅ 通過：current={gsr['current']:.2f} avg_1y={gsr['avg_1y']:.2f} signal={gsr['signal']}")
