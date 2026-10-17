#!/usr/bin/env python3
"""
Sentinel Unified v4.0 — 入口
合併 Sentinel Risk Monitor + Financial Risk Monitor
"""

import sys
import os

# Ensure src/ is in path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from generate_report import run

if __name__ == "__main__":
    run()
