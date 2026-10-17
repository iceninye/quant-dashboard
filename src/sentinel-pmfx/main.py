#!/usr/bin/env python3
"""Hermes Sentinel PMFX — Entry Point"""
import sys
import os

# Ensure project root is in path for configs/
_project_root = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _project_root)
sys.path.insert(0, os.path.join(_project_root, "src"))

from src.core import run_once


def main():
    config = sys.argv[1] if len(sys.argv) > 1 else "configs/config.yaml"
    report = run_once(config)
    print(f"\n✅ 完成。分析 {report['analyzed']}/{report['universe']} 標的")
    print(f"   買: {report['buy']} | 沽: {report['sell']} | 觀望: {report['hold']}")


if __name__ == "__main__":
    main()
