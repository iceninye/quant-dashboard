"""PMFX 2026-10-17 修復回歸測試（**只讀**：唔寫任何 report / CSV / 圖）

用法：cd ~/hermes-projects/sentinel-pmfx && .venv-pmfx/bin/python verify_fix.py
詳細記錄：~/quant-dashboard/docs/FIXES.md
"""
import sys, time
sys.path.insert(0, '.')
import pandas as pd
from src import core

print("=== 1) metrics()：風險指標唔應該再有 error（Bug 1）===")
fails = 0
for tk in ["0005.HK", "JNJ", "GC=F", "BTC-USD"]:
    df = core.download_history(tk, "2y", "1d")
    close = pd.Series(df["Close"].astype(float).to_numpy(),
                      index=pd.to_datetime(df["Date"], errors="coerce")).dropna()
    m = core.metrics(close)
    good = (not m.get("error")) and isinstance(m.get("sharpe"), float)
    fails += 0 if good else 1
    print(f"  {'✓' if good else '✗'} {tk:9} rows={len(close):4} index={type(close.index).__name__:13} "
          f"sharpe={m.get('sharpe')} vol={m.get('ann_volatility')} mdd={m.get('max_drawdown')} err={m.get('error')!r}")
    time.sleep(0.8)

print("\n=== 2) 止損距離 / RR / validity 一致性（Bug 2 + Fix 5）===")
st = core.load_settings("configs/config.yaml")
bhist = core.download_history("DX-Y.NYB", st.market.history_period, st.market.interval)
bench = core.normalize_close(bhist)
print(f"  benchmark index={type(bench.index).__name__} len={len(bench)}（Fix 2b：應為 DatetimeIndex）")
if type(bench.index).__name__ != "DatetimeIndex":
    fails += 1
for tk in ["GC=F", "BTC-USD", "0005.HK", "EURUSD=X"]:
    hist = core.download_history(tk, st.market.history_period, st.market.interval)
    row = core._build_signal_row(tk, hist, st, benchmark=bench, sim_paths=400, sim_steps=120, seed=42)
    if not row:
        print(f"  - {tk:9} row 空（數據不足）"); continue
    e, s = row.get("entry_price", 0), row.get("stop_loss", 0)
    dist = abs(e - s) / e * 100 if e else 0
    rrv, nrrv = bool(row.get("rr_valid")), bool(row.get("net_rr_valid"))
    # 不變條件：有 action 嘅行止損距離 ≥ 0.5%；net_rr_valid 唔可以喺 rr_valid=False 時為 True
    ok_dist = dist == 0 or dist >= 0.5
    ok_flag = (not nrrv) or rrv
    fails += 0 if (ok_dist and ok_flag) else 1
    print(f"  {'✓' if ok_dist and ok_flag else '✗'} {tk:9} action={row.get('action'):5} 止損距離={dist:5.2f}% "
          f"rr={row.get('reward_risk', 0):6.2f} rrv={rrv} net_rr={row.get('net_rr', 0):6.2f} net_rrv={nrrv} "
          f"sharpe={row.get('sharpe')} beta={row.get('beta')} opp={row.get('opportunity_score')}")
    time.sleep(0.5)

print(f"\n{'✅ 全部通過' if fails == 0 else f'❌ {fails} 項失敗'}（呢個 script 冇寫過任何檔案）")
sys.exit(1 if fails else 0)
