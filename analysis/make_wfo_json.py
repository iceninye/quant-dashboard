#!/usr/bin/env python3
"""跑 analysis/wfo_lowmdd_standalone.py 嘅函數，輸出 docs/data/wfo.json（Dashboard 用嘅聚合結果）。

只放統計數字，唔放價格資料。數字全部由本機真跑得出，來源 prices 路徑會寫入 JSON。

用法: python3 analysis/make_wfo_json.py
"""
import json, os, sys, datetime
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wfo_lowmdd_standalone as W          # noqa: E402

PRICES = '/mnt/d/project-files/prices'
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'docs', 'data', 'wfo.json')

RUNS = [
    dict(label='港股 2 年', market='HK', file='quant-hk_prices_16-10-2026.csv',
         note='quant-hk output 最新一份 prices（run 當日 universe）',
         cost_bps=30, top=10, rebalance=21, windows=[63, 126], folds=3, min_train_frac=0.3),
    dict(label='港股 6 年', market='HK', file='quant-hk_6y_2026-10-17.csv',
         note='同一批 ticker 用 yfinance period=6y 重抓，跨 2021-22 熊市；唔係 repo 產物',
         cost_bps=30, top=10, rebalance=21, windows=[63, 126, 252], folds=4, min_train_frac=0.3),
    dict(label='美股 2 年', market='US', file='quant-us_prices_17-10-2026.csv',
         note='quant-us output 最新一份 prices（run 當日 universe）',
         cost_bps=10, top=10, rebalance=21, windows=[63, 126], folds=3, min_train_frac=0.3),
]


def clean(d):
    return {k: (None if isinstance(v, float) and v != v else v) for k, v in d.items()}


def power(s, rebalance):
    sd, mean, n = s.get('excess_period_sd'), s.get('excess_mean_period'), s.get('n_periods', 0)
    if not sd or not mean or mean <= 0:
        return dict(need_periods=None, need_years=None, have_periods=n,
                    note='超額平均 ≤ 0 或波動為 0，power 計算冇意義')
    import math
    need = math.ceil((2.0 * sd / mean) ** 2)
    return dict(need_periods=need, need_years=round(need * rebalance / W.TRADING_DAYS, 1),
                have_periods=n, note='以觀察到嘅每期超額/標準差計，要 |t|=2 所需持有期')


runs_out = []
for r in RUNS:
    path = os.path.join(PRICES, r['file'])
    if not os.path.exists(path):
        print(f"  ⚠️ 缺 {path}，跳過"); continue
    px = W.load_prices(path)
    print(f"  跑 {r['label']}: {px.shape[1]} 隻 × {px.shape[0]} 日")
    allruns, res, oos = W.walk_forward(px, r['windows'], r['top'], r['rebalance'],
                                       r['cost_bps'], r['folds'], r['min_train_frac'])
    total = clean(W.summarize(oos, 'OOS 串連'))
    folds = []
    for k, w, score, s, e, o in res:
        d = clean(W.summarize(o, f'fold{k+1} W={w}'))
        d.update(fold=k + 1, window=w, is_excess_mean_period=round(score, 6),
                 start=str(s.date()), end=str(e.date()))
        folds.append(d)
    runs_out.append(dict(
        label=r['label'], market=r['market'], prices_file=r['file'], note=r['note'],
        data_span=f"{px.index[0].date()} → {px.index[-1].date()}",
        n_tickers=int(px.shape[1]), n_days=int(px.shape[0]),
        config=dict(cost_bps=r['cost_bps'], top=r['top'], rebalance_days=r['rebalance'],
                    windows=r['windows'], folds=r['folds'], entry='t+1 收市', weights='每期等權買入持有'),
        full_sample=[clean(W.summarize(d, f'W={w}')) for w, d in allruns.items()],
        folds=folds, oos=total, power=power(total, r['rebalance']),
    ))

doc = dict(
    generated=datetime.datetime.now().astimezone().isoformat(timespec='seconds'),
    generator='analysis/make_wfo_json.py',
    engine='analysis/wfo_lowmdd_standalone.py',
    strategy='MDD 回望窗口內最淺（絕對值最細）嘅前 top 隻，每 rebalance_days 日換倉，等權買入持有',
    source='本機真跑；prices 唔入 repo（見 prices_file / note）',
    verified_by='Hana（本機），2026-10-17',
    caveats=[
        'Universe = run 當日最活躍名單 → 有倖存者偏差，絕對回報只可當上界',
        '樣本期短：港股 6 年只有 42 個持有期，遠低於 power 要求',
        '用收市價成交，未計滑價／停牌／成交額限制',
        '多重比較未校正（6 因子 × 2 市場 × 2 持有期）',
        '數據源：Yahoo Finance（同一源），6 年樣本只係時間上獨立，非數據源獨立',
        '港股 2 年樣本嘅 power 顯示只需 3 期，係因為該窗口每期超額標準差細（樣本太短）→ 唔可以照字面信；同一策略 6 年樣本標準差大得多（5.45%），要 89 期',
    ],
    runs=runs_out,
)
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(doc, f, ensure_ascii=False, indent=1)
print(f"  寫出 {OUT}  ({os.path.getsize(OUT)/1024:.1f} KB)")
