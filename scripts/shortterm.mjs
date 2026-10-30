// shortterm.mjs — 短線（持有 1–5 個交易日）訊號檢驗 + 今日排名
//
// 規則（同 factors.mjs testFactor 一致，只係持有期短咗、訊號多咗價格反轉／動量）：
//   1. 訊號日 d 收市計訊號，之後第一個收市價入場（t+1），持有 H 行，每個窗口扣 CFG.costPct 來回成本
//      （唔按換手打折：短線頭 20% 每期大部分會換，當全換計，偏保守）
//   2. 每日揀訊號頭 20%，同當日全體等權（唔扣成本）比 → 超額
//   3. 前後半切 IS / OOS；非重疊窗口（每 H 日一個）計 t
//   4. 短線家族 m 個檢定自己一齊做 Holm；通過 = IS、OOS 超額 > 0、t ≥ 2、Holm 單尾 p < 0.05、窗口 ≥ 8
//      觀察 = IS、OOS 都 > 0、t ≥ 1.5（或 t ≥ 2 但 Holm 唔夠）
//   5. 今日排名只列「通過」或「觀察」檢定嘅頭 20%；冇就直講冇，唔會降門檻
// 限制：repo 只有日收市，冇 OHLC／盤中數據，日內策略測唔到；universe 係每日報告名單（有倖存者偏差）。
import { num } from './lib/csv.mjs';
import { priceSeries, fwdReturn, tPValue, holm, FCFG } from './factors.mjs';

export const SCFG = { horizons: [1, 2, 3, 5], topFrac: FCFG.topFrac, minNames: FCFG.minNames, minWindows: FCFG.minWindows,
  tPass: FCFG.tPass, tWatch: FCFG.tWatch, alpha: FCFG.alpha };

const DAY = 86400000;
const n = (v) => num(v);

// k 行回報（d 當日收市對 k 行前），跨缺口（日曆日 > k×1.4+5）→ null
function pastReturn(s, i, k) {
  if (!s || i - k < 0) return null;
  if ((Date.parse(s.dates[i]) - Date.parse(s.dates[i - k])) / DAY > k * 1.4 + 5) return null;
  return s.px[i] / s.px[i - k] - 1;
}

// valueOf({ row, s, i }) 越大越好；s/i = 該股價格序列同 d 嘅位置
export const SIGNALS = [
  { key: 'rev1', label: '1 日反轉（昨日最跌）', valueOf: ({ s, i }) => { const r = pastReturn(s, i, 1); return r === null ? null : -r; } },
  { key: 'mom1', label: '1 日動量（昨日最升）', valueOf: ({ s, i }) => pastReturn(s, i, 1) },
  { key: 'rev5', label: '5 日反轉（一週最跌）', valueOf: ({ s, i }) => { const r = pastReturn(s, i, 5); return r === null ? null : -r; } },
  { key: 'mom5', label: '5 日動量（一週最升）', valueOf: ({ s, i }) => pastReturn(s, i, 5) },
  { key: 'lowvol', label: '低波動', valueOf: ({ row }) => (n(row.vol) === null ? null : -n(row.vol)) },
  { key: 'mdd', label: '回撤最淺（低 MDD）', valueOf: ({ row }) => n(row.mdd) },
];

const MARKET = { hk: '港股', us: '美股' };
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const tstat = (a) => {
  if (a.length < 3) return null;
  const m = mean(a), sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
  return sd > 0 ? m / sd * Math.sqrt(a.length) : null;
};
const r4 = (v) => (v === null ? null : Math.round(v * 1e4) / 1e4);
const r2 = (v) => (v === null ? null : Math.round(v * 100) / 100);

// 一個市場：date → [{ ticker, row, s, i }]
function universe(rows, series) {
  const idx = new Map([...series].map(([t, s]) => [t, new Map(s.dates.map((d, i) => [d, i]))]));
  const byDate = new Map();
  for (const row of rows) {
    const s = series.get(row.ticker), i = idx.get(row.ticker)?.get(row.date);
    if (!s || i === undefined) continue;
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push({ ticker: row.ticker, row, s, i });
  }
  return byDate;
}

function testSignal(byDate, sig, H, fwdCache, cost) {
  const dates = [...byDate.keys()].sort();
  const daily = [];
  for (const d of dates) {
    const pool = [];
    for (const u of byDate.get(d)) {
      const v = sig.valueOf(u);
      if (v === null || !Number.isFinite(v)) continue;
      const key = u.ticker + '|' + d + '|' + H;
      if (!fwdCache.has(key)) fwdCache.set(key, fwdReturn(u.s, d, H));
      const f = fwdCache.get(key);
      if (f !== null) pool.push([v, f]);
    }
    if (pool.length < SCFG.minNames) continue;
    pool.sort((a, b) => b[0] - a[0]);
    const top = mean(pool.slice(0, Math.max(1, Math.floor(pool.length * SCFG.topFrac))).map((x) => x[1]));
    const ew = mean(pool.map((x) => x[1])) + cost;   // 基準唔扣成本（買入持有）
    daily.push({ d, top, ew, excess: top - ew });
  }
  if (!daily.length) return null;
  const half = daily[Math.floor(daily.length / 2)].d;
  const isEx = mean(daily.filter((x) => x.d < half).map((x) => x.excess));
  const oosEx = mean(daily.filter((x) => x.d >= half).map((x) => x.excess));
  const nonOverlap = daily.filter((_, k) => k % H === 0).map((x) => x.excess);
  const t = tstat(nonOverlap);
  const both = isEx > 0 && oosEx > 0 && t !== null;
  return {
    H, days: daily.length, windows: nonOverlap.length, from: daily[0].d, to: daily.at(-1).d,
    top: r4(mean(daily.map((x) => x.top))), ew: r4(mean(daily.map((x) => x.ew))),
    excess: r4(mean(daily.map((x) => x.excess))), isExcess: r4(isEx), oosExcess: r4(oosEx),
    beatRate: Math.round(100 * daily.filter((x) => x.excess > 0).length / daily.length),
    t: r2(t), p: t === null ? null : tPValue(t, nonOverlap.length - 1), adjP: null,
    grade: nonOverlap.length < SCFG.minWindows ? 'fail'
      : both && t >= SCFG.tPass ? 'pass' : both && t >= SCFG.tWatch ? 'watch' : 'fail',
  };
}

// fam：{ hk, us, backfill }；costPct：同 CFG.costPct
export function shortTermScan(fam, costPct) {
  const tests = [], latest = {}, unis = {};
  for (const m of ['hk', 'us']) {
    const rows = fam[m] || [];
    if (!rows.length) continue;
    const series = priceSeries([...rows, ...(fam.backfill || [])]);
    const byDate = universe(rows, series);
    unis[m] = byDate;
    latest[m] = [...byDate.keys()].sort().at(-1);
    const cache = new Map();
    for (const sig of SIGNALS) for (const H of SCFG.horizons) {
      const r = testSignal(byDate, sig, H, cache, costPct / 100);
      if (r) tests.push({ key: sig.key, label: sig.label, market: m, marketLabel: MARKET[m], ...r });
    }
  }
  const adj = holm(tests.map((x) => (x.windows >= SCFG.minWindows ? x.p : null)));
  const mTests = adj.filter((x) => x !== null).length;
  tests.forEach((x, i) => {
    x.adjP = adj[i] === null ? null : r4(adj[i]); x.p = x.p === null ? null : r4(x.p); x.m = mTests;
    if (x.grade === 'pass' && !(adj[i] < SCFG.alpha)) x.grade = 'watch';
  });
  const rank = { pass: 0, watch: 1, fail: 2 };
  tests.sort((a, b) => rank[a.grade] - rank[b.grade] || (b.t ?? -99) - (a.t ?? -99));

  // 今日排名：每個市場 + 訊號只取最強嘅持有期，fail 唔列名單
  const today = [];
  const seen = new Set();
  for (const x of tests.filter((t) => t.grade !== 'fail')) {
    const id = x.market + '|' + x.key;
    if (seen.has(id)) continue;
    seen.add(id);
    const sig = SIGNALS.find((s) => s.key === x.key);
    const pool = (unis[x.market].get(latest[x.market]) || []).map((u) => [u, sig.valueOf(u)])
      .filter((p) => p[1] !== null && Number.isFinite(p[1])).sort((a, b) => b[1] - a[1]);
    const k = Math.max(1, Math.floor(pool.length * SCFG.topFrac));
    today.push({
      key: x.key, label: x.label, market: x.market, marketLabel: x.marketLabel, date: latest[x.market],
      grade: x.grade, H: x.H, excess: x.excess, t: x.t, adjP: x.adjP,
      names: pool.slice(0, k).map(([u, v]) => ({ ticker: u.ticker, close: n(u.row.close), value: r4(v),
        r1: r4(pastReturn(u.s, u.i, 1)), r5: r4(pastReturn(u.s, u.i, 5)), vol: n(u.row.vol), mdd: n(u.row.mdd) })),
    });
  }
  // 反方向：顯著跑輸（單尾 P(T ≤ t)，Bonferroni × m，比 Holm 更保守）→ 提醒唔好咁做
  const avoid = tests.filter((x) => x.windows >= SCFG.minWindows && x.t !== null && x.t < 0)
    .map((x) => ({ ...x, lowP: r4(Math.min(1, mTests * tPValue(-x.t, x.windows - 1))) }))
    .filter((x) => x.lowP < SCFG.alpha).sort((a, b) => a.t - b.t);
  return {
    cfg: { ...SCFG, costPct }, m: mTests, dates: latest,
    counts: { tests: tests.length, pass: tests.filter((x) => x.grade === 'pass').length, watch: tests.filter((x) => x.grade === 'watch').length },
    tests, today,
    avoid,
  };
}
