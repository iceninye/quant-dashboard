#!/usr/bin/env python3
"""將 run_local_validation.sh 嘅 SUMMARY.md 轉成 docs/data/scan.json（Dashboard §2b 用）

只放統計數字同今日名單，唔放價格。

用法：
  python3 analysis/make_scan_json.py                          # 用最新 results/local-*/SUMMARY.md
  python3 analysis/make_scan_json.py --summary path/to/SUMMARY.md
之後 bash scripts/publish.sh（build 會讀 scan.json）。
"""
from __future__ import annotations

import argparse
import collections
import glob
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs", "data", "scan.json")
LABEL = {"today-list": "今日名單 2 年", "union": "曾入榜 6 年", "union-pit": "曾入榜 6 年（只計入榜後）"}


def num(s: str):
    s = s.strip().replace("%", "")
    try:
        return float(s)
    except ValueError:
        return None


def table(lines: list[str], head: str) -> list[list[str]]:
    rows, on = [], False
    for ln in lines:
        if ln.startswith(head):
            on = True
            continue
        if on:
            if ln.startswith("|---"):
                continue
            if not ln.startswith("|"):
                break
            rows.append([c.strip() for c in ln.strip().strip("|").split("|")])
    return rows


def parse_section(key: str, body: str) -> dict | None:
    m = re.search(r"# 機會掃描：(\w+)（數據 (\S+) → (\S+)，(\d+) 日 × (\d+) 隻）", body)
    if not m:
        return None
    market, variant = key.split(" / ")
    lines = body.splitlines()
    c = re.search(r"可評級檢定 (\d+) 個；PASS (\d+)、WATCH (\d+)、FAIL (\d+)、UNGRADED (\d+)", body)
    bench = re.search(r"基準：([^、]+)、point-in-time universe：(.)", body)
    regime = re.search(r"大市今日：(.+)", body)
    tests = []
    for r in table(lines, "| 檢定 |"):
        if len(r) < 19:
            continue
        sig, h = r[0].split("@")
        tests.append({"signal": sig, "H": int(h), "grade": r[1], "periods": int(r[2]), "excess": num(r[3]),
                      "t": num(r[4]), "holm": num(r[6]), "dsr": num(r[7]), "is": num(r[8]), "oos": num(r[9]),
                      "oos_t": num(r[10]), "ann": num(r[11]), "ew_ann": num(r[12]), "mdd": num(r[13]),
                      "bull": num(r[14]), "bear": num(r[15]), "years_pos": r[16]})
    meta = [{"H": int(r[0].split()[0]), "periods": int(r[1]), "excess": num(r[2]), "t": num(r[3]), "p": num(r[4]),
             "abs": num(r[5]), "mdd": num(r[6]), "last_pick": r[7]} for r in table(lines, "| 持有期 |") if len(r) >= 8]
    picks = []
    for p in re.finditer(r"^- \*\*(\w+)\*\*（(\w+)，最佳持有期 (\d+) 日）：(.+)$", body, re.M):
        picks.append({"signal": p[1], "grade": p[2], "H": int(p[3]), "tickers": [t.strip() for t in p[4].split("、")]})
    return {
        "key": f"{market}-{variant}", "market": market, "variant": variant, "label": LABEL.get(variant, variant),
        "start": m[2], "asof": m[3], "days": int(m[4]), "tickers": int(m[5]),
        "bench": bench[1] if bench else None, "pit": bool(bench and bench[2] == "有"),
        "regime": regime[1].strip() if regime else None,
        "counts": dict(zip(["tests", "pass", "watch", "fail", "ungraded"], map(int, c.groups()))) if c else None,
        "top": tests, "meta": meta, "picks": picks,
    }


def consensus(samples: list[dict], market: str) -> list[dict]:
    """同一市場：PASS/WATCH 因子今日名單入面出現次數（用最新數據嘅樣本嘅名單，每個因子只計一次）"""
    seen, cnt = set(), collections.Counter()
    for s in [x for x in samples if x["market"] == market]:
        for p in s["picks"]:
            if p["signal"] in seen:
                continue
            seen.add(p["signal"])
            cnt.update(p["tickers"])
    return [{"ticker": t, "count": n, "of": len(seen)} for t, n in cnt.most_common(10)]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--summary")
    ap.add_argument("--out", default=OUT)
    a = ap.parse_args(argv)
    path = a.summary or (sorted(glob.glob(os.path.join(ROOT, "results", "local-*", "SUMMARY.md"))) or [None])[-1]
    if not path or not os.path.exists(path):
        print("搵唔到 SUMMARY.md（先跑 analysis/run_local_validation.sh，或者用 --summary）", file=sys.stderr)
        return 2
    text = open(path, encoding="utf-8").read()
    run = re.search(r"# 本機驗證 (.+)", text)
    samples = [s for s in (parse_section(k, b) for k, b in re.findall(r"^### (\w+ / [\w-]+)\n(.*?)(?=^### |^## \d|\Z)", text, re.M | re.S)) if s]
    if not samples:
        print("SUMMARY.md 入面冇掃描結果", file=sys.stderr)
        return 3
    out = {"run": run[1].strip() if run else None, "source": os.path.basename(os.path.dirname(path)) or path,
           "samples": samples, "consensus": {m: consensus(samples, m) for m in sorted({s["market"] for s in samples})}}
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    print(f"已寫 {os.path.relpath(a.out, ROOT)}：{len(samples)} 個樣本；" +
          "；".join(f"{m} 共識 {len(v)} 隻" for m, v in out["consensus"].items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
