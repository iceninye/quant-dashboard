// factors.mjs — 用 HK / US quant 同 Sentinel 嘅歷史數據，驗證邊個訊號真係有前向回報
//
// 規則（同 forwardTrack 一致）：
//   1. 訊號日 d 之後第一個收市價入場（t+1），持有 H 行，扣 CFG.costPct 來回成本
//   2. 持有期跨越數據缺口（日曆日 > H×1.4+5）嘅窗口唔計，避免 15 日空檔被當成 5 日
//   3. 每日揀因子頭 20%，同當日全體等權比（超額回報）
//   4. 樣本按日期前後切半：前半 in-sample、後半 out-of-sample
//   5. 通過 = IS 超額 > 0、OOS 超額 > 0、非重疊窗口 t ≥ 2，而且 Holm 校正後單尾 p < 0.05（四樣都要）
//      Holm 校正針對「同時測咗 m 個因子 × 市場 × 持有期」嘅多重比較（m = 有 t 值嘅檢定數）
//      觀察 = IS、OOS 都 > 0，但 t 只係 1.5–2，或者 t ≥ 2 但 Holm 校正後唔夠（只入觀察名單）
import { num } from './lib/csv.mjs';
import { CFG, sentiOf } from './engine.mjs';

export const FCFG = { horizons: [5, 20], topFrac: 0.2, minNames: 30, minNamesSentinel: 10, tPass: 2, tWatch: 1.5, alpha: 0.05 };

const n = (v) => num(v);
const DAY = 86400000;
const days = (a, b) => (Date.parse(b) - Date.parse(a)) / DAY;
const maxSpan = (H) => H * 1.4 + 5;

// ticker → { dates: [...], px: [...] }（已排序）
// 拆股調整：repo 嘅 close 係「當日未復權收市」，拆股日會跳一個整數比例（例：APH 2026-09 −48.9% ≈ 2:1）。
// 單日跌幅 > 30% 而且前價 / 後價 ≈ 整數 k（2–10，±7%）→ 當拆股，將之前價格除以 k。
// 只處理正向拆股；股息唔調整（price return，高息股回報會被低估）。events 有傳入就記低偵測結果。
const SPLIT_K = [2, 3, 4, 5, 6, 7, 8, 9, 10];
export function adjustSplits(ticker, arr, events) {
  for (let i = arr.length - 1; i > 0; i--) {
    const q = arr[i - 1][1] / arr[i][1];
    if (q < 1.43) continue;                                  // 即跌幅 < 30%
    const k = SPLIT_K.find((x) => Math.abs(q / x - 1) <= 0.07);
    if (!k) continue;
    for (let j = 0; j < i; j++) arr[j][1] /= k;
    events?.push({ ticker, from: arr[i - 1][0], to: arr[i][0], k });
  }
}

export function priceSeries(rows, events = null) {
  const m = new Map();
  for (const r of rows) {
    const c = n(r.close);
    if (c === null || c <= 0) continue;
    if (!m.has(r.ticker)) m.set(r.ticker, []);
    m.get(r.ticker).push([r.date, c]);
  }
  for (const [k, arr] of m) {
    arr.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    adjustSplits(k, arr, events);
    m.set(k, { dates: arr.map((x) => x[0]), px: arr.map((x) => x[1]) });
  }
  return m;
}

// 訊號日 d → t+1 入場、持有 H 行嘅扣成本回報；跨缺口或數據唔夠 → null
export function fwdReturn(s, d, H) {
  if (!s) return null;
  let i = s.dates.findIndex((x) => x > d);
  if (i < 0 || i + H >= s.dates.length) return null;
  if (days(s.dates[i], s.dates[i + H]) > maxSpan(H)) return null;
  return s.px[i + H] / s.px[i] - 1 - CFG.costPct / 100;
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const tstat = (a) => {
  if (a.length < 3) return null;
  const m = mean(a), sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
  return sd > 0 ? m / sd * Math.sqrt(a.length) : null;
};

// ---- Student-t 單尾 p（正則化不完全 Beta，Lentz 連分數）----
function lgamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, t = x + 5.5; t -= (x + 0.5) * Math.log(t);
  let ser = 1.000000000190015;
  for (const k of c) ser += k / ++y;
  return -t + Math.log(2.5066282746310005 * ser / x);
}
function betacf(a, b, x) {
  const TINY = 1e-30;
  let c = 1, d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d; let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < 3e-12) break;
  }
  return h;
}
function ibeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
}
// P(T ≥ t)，df 自由度
export function tPValue(t, df) {
  if (t === null || !(df >= 1)) return null;
  const two = ibeta(df / (df + t * t), df / 2, 0.5);
  return t >= 0 ? two / 2 : 1 - two / 2;
}
// Holm step-down：輸入 p 陣列（null 跳過），返回同序校正後 p
export function holm(ps) {
  const idx = ps.map((p, i) => [p, i]).filter((x) => x[0] !== null).sort((a, b) => a[0] - b[0]);
  const m = idx.length, out = ps.map(() => null);
  let run = 0;
  idx.forEach(([p, i], k) => { run = Math.max(run, Math.min(1, (m - k) * p)); out[i] = run; });
  return out;
}

const r4 = (v) => (v === null ? null : Math.round(v * 1e4) / 1e4);
const r2 = (v) => (v === null ? null : Math.round(v * 100) / 100);

// 一個因子喺一個 universe 嘅檢驗；valueOf(row) 越大越好
function testFactor(rows, series, valueOf, H, minNames, discrete) {
  const byDate = new Map();
  for (const r of rows) {
    const v = valueOf(r);
    if (v === null || !Number.isFinite(v)) continue;
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push([r.ticker, v]);
  }
  const dates = [...byDate.keys()].sort();
  const daily = [];
  for (const d of dates) {
    const pool = byDate.get(d).map(([t, v]) => [t, v, fwdReturn(series.get(t), d, H)]).filter((x) => x[2] !== null);
    if (pool.length < minNames) continue;
    pool.sort((a, b) => b[1] - a[1]);
    // 離散因子（Sentinel 建議）用「最高一級 vs 最低一級」，唔用頭 20%（同分太多）
    const hi = pool[0][1], lo = pool.at(-1)[1];
    const topArr = discrete ? pool.filter((x) => x[1] === hi) : pool.slice(0, Math.max(1, Math.floor(pool.length * FCFG.topFrac)));
    const botArr = discrete ? pool.filter((x) => x[1] === lo) : pool.slice(-Math.max(1, Math.floor(pool.length * FCFG.topFrac)));
    if (discrete && hi === lo) continue;
    const top = mean(topArr.map((x) => x[2]));
    const bot = mean(botArr.map((x) => x[2]));
    const ew = mean(pool.map((x) => x[2])) + CFG.costPct / 100;   // 基準唔扣成本（買入持有）
    daily.push({ d, top, ew, excess: top - ew, spread: top - bot });
  }
  if (!daily.length) return null;
  const half = dates[Math.floor(dates.length / 2)];
  const is = daily.filter((x) => x.d < half), oos = daily.filter((x) => x.d >= half);
  const nonOverlap = daily.filter((_, i) => i % H === 0).map((x) => x.excess);
  const t = tstat(nonOverlap);
  const isEx = mean(is.map((x) => x.excess)), oosEx = mean(oos.map((x) => x.excess));
  return {
    H, days: daily.length, windows: nonOverlap.length,
    top: r4(mean(daily.map((x) => x.top))), ew: r4(mean(daily.map((x) => x.ew))),
    excess: r4(mean(daily.map((x) => x.excess))), spread: r4(mean(daily.map((x) => x.spread))),
    beatRate: Math.round(100 * daily.filter((x) => x.excess > 0).length / daily.length),
    isExcess: r4(isEx), oosExcess: r4(oosEx), t: r2(t),
    p: t === null ? null : tPValue(t, nonOverlap.length - 1), adjP: null,
    grade: isEx > 0 && oosEx > 0 && t !== null && t >= FCFG.tPass ? 'pass'   // 未做 Holm；validateFactors 再降級
      : isEx > 0 && oosEx > 0 && t !== null && t >= FCFG.tWatch ? 'watch' : 'fail',
  };
}

export const FACTORS = [
  { key: 'mdd', label: '回撤最淺（低 MDD）', fam: ['hk', 'us'], valueOf: (r) => n(r.mdd) },
  { key: 'lowvol', label: '低波動', fam: ['hk', 'us'], valueOf: (r) => (n(r.vol) === null ? null : -n(r.vol)) },
  { key: 'sharpe', label: 'Sharpe 最高', fam: ['hk', 'us'], valueOf: (r) => n(r.sharpe) },
  { key: 'month', label: '月動量', fam: ['hk', 'us'], valueOf: (r) => n(r.month) },
  { key: 'weekrev', label: '週反轉（上週最差）', fam: ['hk', 'us'], valueOf: (r) => (n(r.week) === null ? null : -n(r.week)) },
  { key: 'sentinel', label: 'Sentinel 建議（可加倉 > 觀望 > 減持）', fam: ['sentinel'], valueOf: (r) => sentiOf(r.action), discrete: true },
];

const MARKET = { hk: '港股', us: '美股', sentinel: 'Sentinel 29 隻' };

// prices：ticker → series（HK/US quant 收市優先，PMFX 補其餘）
export function validateFactors(fam, prices) {
  const out = [];
  for (const f of FACTORS) for (const m of f.fam) {
    const rows = fam[m] || [];
    const minNames = m === 'sentinel' ? FCFG.minNamesSentinel : FCFG.minNames;
    const series = m === 'sentinel' ? prices : priceSeries([...rows, ...(fam.backfill || [])]);   // backfill 只有收市價，補缺口期嘅持有期回報
    const res = FCFG.horizons.map((H) => testFactor(rows, series, f.valueOf, H, minNames, f.discrete)).filter(Boolean);
    if (!res.length) continue;
    out.push({ key: f.key, label: f.label, market: m, marketLabel: MARKET[m], byH: res });
  }
  // 多重比較：所有有 t 值嘅檢定一齊做 Holm
  const all = out.flatMap((f) => f.byH);
  const adj = holm(all.map((h) => h.p));
  const mTests = adj.filter((x) => x !== null).length;
  all.forEach((h, i) => {
    h.adjP = adj[i] === null ? null : r4(adj[i]); h.p = h.p === null ? null : r4(h.p); h.m = mTests;
    if (h.grade === 'pass' && !(adj[i] < FCFG.alpha)) h.grade = 'watch';
  });
  for (const f of out)
    f.grade = f.byH.some((x) => x.grade === 'pass') ? 'pass' : f.byH.some((x) => x.grade === 'watch') ? 'watch' : 'fail';
  const rank = { pass: 0, watch: 1, fail: 2 };
  const bestEx = (f) => Math.max(...f.byH.map((h) => h.excess ?? -1));
  return out.sort((a, b) => rank[a.grade] - rank[b.grade] || bestEx(b) - bestEx(a));
}

// 今日名單：通過或觀察級因子嘅頭 20%，附其他報告嘅交叉資料
export function picksFor(fam, validated, ctxSen, pmLatest) {
  const picks = [];
  for (const v of validated.filter((x) => x.grade !== 'fail' && x.market !== 'sentinel')) {
    const f = FACTORS.find((x) => x.key === v.key);
    const rows = fam[v.market];
    const d = rows.reduce((m, r) => (r.date > m ? r.date : m), '');
    const today = rows.filter((r) => r.date === d).map((r) => [r, f.valueOf(r)]).filter((x) => x[1] !== null);
    today.sort((a, b) => b[1] - a[1]);
    const k = Math.max(1, Math.floor(today.length * FCFG.topFrac));
    picks.push({
      key: v.key, label: v.label, market: v.market, marketLabel: v.marketLabel, date: d, grade: v.grade,
      best: v.byH.filter((x) => x.grade === v.grade).sort((a, b) => b.t - a.t)[0],
      names: today.slice(0, k).map(([r, val]) => {
        const sn = ctxSen.get(r.ticker), pm = pmLatest.get(r.ticker);
        return { ticker: r.ticker, name: r.name || '', close: n(r.close), value: val,
          sharpe: n(r.sharpe), vol: n(r.vol), mdd: n(r.mdd), month: n(r.month),
          sentinel: sn ? sn.action : null, pmfx: pm ? pm.action : null };
      }),
    });
  }
  return picks;
}
