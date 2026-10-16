// engine.mjs — Opportunity Engine
// 目標：由 4 份報告交叉篩出「最大獲利機會」，並且分開「可信 / 退化 / 唔可信」。
//
// 核心原則（唔可以妥協）：
//   1. 只有 PMFX 有 entry/target/stop/EV → 佢係唯一嘅「機會來源」
//   2. 跨報告（quant sharpe/momentum + Sentinel action）只用嚟做「加成/扣分」，唔可以無中生有
//   3. 任何 EV 排序都必須先過 quality gate；唔過關嘅高分係「退化」（止損 ≈ 0 → RR 爆表）
//   4. 每個訊號都要入前向追蹤（hit / stop / 中性），用實際價算，唔靠模型自評
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, num } from './lib/csv.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CFG = {
  minStopPct: 0.3,     // 止損距離 < 0.3% 視為退化（今日 BTC-USD 得 0.1%）
  maxStopPct: 12,      // 止損 > 12% 唔算「短線機會」
  minRR: 1.0,
  minNetEv: 0,
  budgetMB: 20,
};

// ---------- 讀已 sync 嘅分片 ----------
function loadFamily(fam) {
  const dir = path.join(ROOT, 'data', fam);
  const rows = [];
  if (!fs.existsSync(dir)) return rows;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.csv')).sort())
    rows.push(...parseCsv(fs.readFileSync(path.join(dir, f), 'utf8')));
  return rows;
}
export function loadAll() {
  const fam = {};
  for (const f of ['hk', 'us', 'sentinel', 'pmfx', 'macro']) fam[f] = loadFamily(f);
  return fam;
}
export const latestDate = (rows) => rows.reduce((m, r) => (r.date > m ? r.date : m), '');
const byDate = (rows) => rows.reduce((m, r) => ((m[r.date] ||= []).push(r), m), {});
const n = (v) => num(v);

// ---------- 跨報告上下文 ----------
export function buildContext(fam) {
  const ctx = { hk: new Map(), us: new Map(), sen: new Map() };
  const hkD = latestDate(fam.hk), usD = latestDate(fam.us), sD = latestDate(fam.sentinel);
  const fill = (rows, d, key, map) => {
    const pool = []; for (const r of rows) if (r.date === d) pool.push(n(r.sharpe));
    const ok = pool.filter((v) => v !== null).sort((a, b) => a - b);
    for (const r of rows) if (r.date === d) {
      const s = n(r.sharpe);
      map.set(r.ticker, {
        date: d, sharpe: s,
        sharpePct: s === null || !ok.length ? null : Math.round(100 * ok.filter((v) => v <= s).length / ok.length),
        week: n(r.week), month: n(r.month), vol: n(r.vol), mdd: n(r.mdd),
      });
    }
    return key;
  };
  fill(fam.hk, hkD, 'hk', ctx.hk);
  fill(fam.us, usD, 'us', ctx.us);
  for (const r of fam.sentinel) if (r.date === sD)
    ctx.sen.set(r.ticker, { date: sD, action: r.action, risk: r.risk, riskText: r.risk_text, week: n(r.week), month: n(r.month) });
  return { ctx, dates: { hk: hkD, us: usD, sen: sD } };
}

const SBUY = { 可加倉: 1 };
const SSELL = { 建議減持: -1, 強烈減持: -1 };
export function sentiOf(action) {
  const a = (action || '').trim();
  if (a in SBUY) return 1;
  if (a in SSELL) return -1;
  if (a === '觀望') return 0;
  return null;
}
export function pmfxSenti(action) {
  const a = (action || '').trim();
  if (['買', '買入', '增持'].includes(a)) return 1;
  if (['沽', '賣出', '減持'].includes(a)) return -1;
  if (a === '觀望') return 0;
  return null;
}
export function sideOf(action) {          // +1 做多, -1 做空, 0 無方向
  const s = pmfxSenti(action);
  return s === null ? 0 : s;
}

// ---------- Quality gate ----------
export function quality(row) {
  const fails = [];
  const rr = n(row.rr), ev = n(row.net_ev), sp = n(row.stop_pct);
  // Pending Data 佔位行（動態觀察名單數據不足）：全 0 值 + rr_valid 被錯誤設成 true
  if (/^Pending$/i.test((row.action || '').trim())) fails.push('Pending Data（動態觀察名單數據不足）');
  else if (n(row.close) === 0 || n(row.entry) === 0) fails.push('價格為 0（無有效報價）');
  if (String(row.err) === '1') fails.push('引擎異常 (error 欄非空)');
  if (String(row.rrv) !== '1') fails.push('RR 無效 (rr_valid=false)');
  if (String(row.net_rrv) !== '1') fails.push('淨 RR 無效 (net_rr_valid=false)');
  if (sp === null) fails.push('無止損價');
  else if (sp < CFG.minStopPct) fails.push(`止損退化 (${sp.toFixed(2)}% < ${CFG.minStopPct}%)`);
  else if (sp > CFG.maxStopPct) fails.push(`止損太遠 (${sp.toFixed(2)}% > ${CFG.maxStopPct}%)`);
  if (rr !== null && rr < CFG.minRR) fails.push(`RR < ${CFG.minRR}`);
  if (ev === null) fails.push('無 net_ev');
  else if (ev <= CFG.minNetEv) fails.push(`net_ev ≤ ${CFG.minNetEv}`);
  return { ok: fails.length === 0, fails };
}

// ---------- 機會評分 ----------
// score = net_ev 排序為主，加減跨報告共識；再按風險扣分
export function score(row, ctx) {
  const { ctx: c } = ctx;
  const side = sideOf(row.action);                 // PMFX 方向
  let cons = side * 1.0, notes = [];
  const q = c.hk.get(row.ticker) || c.us.get(row.ticker);
  if (q) {
    if (q.sharpePct !== null) {
      // 質素加成：Sharpe 排前 20% 加 0.5；後 20% 扣 0.5（做空時用 momentum 對齊）
      const hi = q.sharpePct >= 80, lo = q.sharpePct <= 20;
      const align = side === 1 ? (hi ? 0.5 : lo ? -0.5 : 0) : (lo ? 0.5 : hi ? -0.5 : 0);
      cons += align;
      notes.push(`Sharpe 排 ${q.sharpePct}%ile`);
    }
    if (q.month !== null) {
      const align = side === 1 ? (q.month > 0 ? 0.25 : -0.25) : (q.month < 0 ? 0.25 : -0.25);
      cons += align;
      notes.push(`月回報 ${(q.month * 100).toFixed(1)}%`);
    }
  }
  const sn = c.sen.get(row.ticker);
  let risk = null;
  if (sn) {
    const ss = sentiOf(sn.action);
    if (ss !== null) cons += ss * side * 0.75 * (side === 0 ? 0 : 1);
    risk = sn.risk;
    notes.push(`Sentinel ${sn.action}${sn.risk ? ' ' + sn.risk : ''}`);
  }
  const sp = n(row.stop_pct), rr = n(row.rr), ev = n(row.net_ev);
  const riskPenalty = (sp || 0) / 10 * 0.5;
  const raw = (ev || 0) * (1 + Math.max(-0.6, Math.min(1.0, cons)) * 0.5) - riskPenalty;
  return { cons: Math.round(cons * 100) / 100, notes, risk, score: Math.round(raw * 1000) / 1000 };
}

export function tierOf(row, sc) {
  const q = quality(row);
  if (!q.ok) return { tier: 'EXCLUDED', why: q.fails };
  const sp = n(row.stop_pct);
  if (sc.cons >= 1 && sp !== null && sp <= 5) return { tier: 'A', why: [] };
  if (sc.cons >= 0) return { tier: 'B', why: [] };
  return { tier: 'C', why: ['跨報告共識為負 → 只作反向觀察'] };
}

// ---------- 前向追蹤（唯一可以證明「機會」真定假）----------
// 用 PMFX 之後幾日嘅 last_price 計實際回報；同時睇有冇觸及 target / stop。
export function forwardTrack(fam) {
  const pm = byDate(fam.pmfx);
  const dates = Object.keys(pm).sort();
  const px = new Map();                    // ticker → [[date, close], ...]
  for (const d of dates) for (const r of pm[d]) {
    const c = n(r.close);
    if (c === null) continue;
    if (!px.has(r.ticker)) px.set(r.ticker, []);
    px.get(r.ticker).push([d, c]);
  }
  const out = [];
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    const sigs = pm[d];
    for (const r of sigs) {
      const ev = n(r.net_ev);
      const q = quality(r);
      if (ev === null || ev <= 0) continue;          // 只追蹤「當日有正面 EV」嘅訊號
      const side = sideOf(r.action);
      if (!side) continue;
      const entry = n(r.entry) || n(r.close);
      const tgt = n(r.target), stp = n(r.stop);
      const series = (px.get(r.ticker) || []).filter(([dd]) => dd > d);
      const ret = (k) => {
        if (series.length < k) return null;
        const c = series[k - 1][1];
        return entry ? side * (c - entry) / entry : null;
      };
      let outcome = 'pending', hitDay = null;
      for (let k = 0; k < Math.min(series.length, 20); k++) {
        const [, c] = series[k];
        const hitT = tgt !== null && (side === 1 ? c >= tgt : c <= tgt);
        const hitS = stp !== null && (side === 1 ? c <= stp : c >= stp);
        if (hitT) { outcome = 'target'; hitDay = k + 1; break; }
        if (hitS) { outcome = 'stop'; hitDay = k + 1; break; }
      }
      if (outcome === 'pending' && series.length >= 20) outcome = 'timeout';
      out.push({
        date: d, ticker: r.ticker, name: r.name, side, action: r.action,
        entry, rr: n(r.rr), net_ev: ev, stopPct: n(r.stop_pct),
        clean: q.ok, outcome, hitDay,
        r1: ret(1), r5: ret(5), r10: ret(10), r20: ret(20),
        daysObserved: series.length,
      });
    }
  }
  return out;
}

// ---------- 組裝 ----------
export function run() {
  const fam = loadAll();
  const ctx = buildContext(fam);
  const pmRows = fam.pmfx.filter((r) => r.date === latestDate(fam.pmfx));
  const scored = pmRows.map((row) => {
    const sc = score(row, ctx);
    const t = tierOf(row, sc);
    return {
      ticker: row.ticker, name: row.name, action: row.action,
      close: n(row.close), entry: n(row.entry), target: n(row.target), stop: n(row.stop),
      stopPct: n(row.stop_pct), rr: n(row.rr), net_rr: n(row.net_rr),
      ev: n(row.ev), net_ev: n(row.net_ev), atr: n(row.atr), votes: n(row.votes),
      opp: n(row.opp), source: row.source, sharpe: n(row.sharpe),
      err: row.err === '1', rrv: row.rrv === '1',
      cons: sc.cons, notes: sc.notes, risk: sc.risk,
      score: sc.score, tier: t.tier, why: t.why,
      upPct: n(row.entry) && n(row.target) ? (sideOf(row.action) > 0
        ? (n(row.target) - n(row.entry)) / n(row.entry) * 100
        : (n(row.entry) - n(row.target)) / n(row.entry) * 100) : null,
    };
  });
  const tracking = forwardTrack(fam);
  const byTier = (t) => tracking.filter((x) => x.clean === (t === 'clean'));
  const stat = (arr) => {
    const done = arr.filter((x) => x.outcome === 'target' || x.outcome === 'stop');
    const wins = done.filter((x) => x.outcome === 'target').length;
    const withR5 = arr.filter((x) => x.r5 !== null);
    return {
      signals: arr.length,
      decided: done.length,
      wins, losses: done.length - wins,
      winRate: done.length ? Math.round(1000 * wins / done.length) / 10 : null,
      avgR5: withR5.length ? Math.round(1e4 * withR5.reduce((s, x) => s + x.r5, 0) / withR5.length) / 1e4 : null,
    };
  };
  const quality = {
    date: latestDate(fam.pmfx),
    total: pmRows.length,
    err: pmRows.filter((r) => r.err === '1').length,
    rrvInvalid: pmRows.filter((r) => r.rrv !== '1').length,
    degenerate: pmRows.filter((r) => { const sp = n(r.stop_pct); return sp !== null && sp < CFG.minStopPct; }).length,
    noStop: pmRows.filter((r) => n(r.stop_pct) === null).length,
    clean: scored.filter((x) => x.tier !== 'EXCLUDED').length,
  };
  const macro = fam.macro.filter((r) => r.date === latestDate(fam.macro))[0] || null;
  return {
    generatedAt: new Date().toISOString(),
    dates: ctx.dates, pmfxDate: latestDate(fam.pmfx), macro,
    cfg: CFG,
    quality,
    opportunities: scored.sort((a, b) => b.score - a.score),
    tracking,
    trackingStats: { clean: stat(byTier('clean')), all: stat(tracking) },
    audit: audit(fam, tracking),
    series: buildSeries(fam),
  };
}

// 歷史序列（用嚟畫趨勢）：每日 clean 候選數、最佳 net_ev、平均 Sharpe
export function buildSeries(fam) {
  const ctx = { ctx: buildContext(fam).ctx };
  const out = [];
  for (const d of Object.keys(byDate(fam.pmfx)).sort()) {
    const rows = fam.pmfx.filter((r) => r.date === d);
    const clean = rows.filter((r) => quality(r).ok);
    const evs = clean.map((r) => n(r.net_ev)).filter((v) => v !== null);
    out.push({
      date: d, total: rows.length, clean: clean.length,
      degenerate: rows.filter((r) => { const sp = n(r.stop_pct); return sp !== null && sp < CFG.minStopPct; }).length,
      err: rows.filter((r) => r.err === '1').length,
      buys: rows.filter((r) => sideOf(r.action) === 1).length,
      sells: rows.filter((r) => sideOf(r.action) === -1).length,
      bestEv: evs.length ? Math.max(...evs) : null,
      maxRr: clean.length ? Math.max(...clean.map((r) => n(r.rr) || 0)) : null,
      best: clean.sort((a, b) => (n(b.net_ev) || -1e9) - (n(a.net_ev) || -1e9))[0]
        ? { ticker: clean[0].ticker, net_ev: n(clean[0].net_ev) } : null,
    });
  }
  return out;
}

// ---------- Gate 審計：拆開睇每個 gate 嘅殺傷力 + 過濾子集嘅前向表現 ----------
export function audit(fam, track = forwardTrack(fam)) {
  const pm = byDate(fam.pmfx);
  const dateOf = new Map();
  for (const d of Object.keys(pm)) for (const r of pm[d]) dateOf.set(d + '|' + r.ticker, r);

  const gates = [
    ['全部有 EV 訊號', () => true],
    ['net_ev > 0', (r) => (n(r.net_ev) || -1e9) > 0],
    ['+ rr_valid', (r) => r.rrv === '1'],
    ['+ 止損 ≥ 0.3%', (r) => (n(r.stop_pct) ?? -1) >= CFG.minStopPct],
    ['+ 引擎無 error', (r) => r.err !== '1'],
    ['+ 止損 ≤ 5%', (r) => (n(r.stop_pct) ?? 1e9) <= 5],
  ];
  const statOf = (arr) => {
    const done = arr.filter((x) => x.outcome === 'target' || x.outcome === 'stop');
    const w = done.filter((x) => x.outcome === 'target').length;
    const r5 = arr.filter((x) => x.r5 !== null);
    const r20 = arr.filter((x) => x.r20 !== null);
    return {
      n: arr.length, decided: done.length, winRate: done.length ? Math.round(1000 * w / done.length) / 10 : null,
      avgR5: r5.length ? Math.round(1e5 * r5.reduce((s, x) => s + x.r5, 0) / r5.length) / 1e5 : null,
      avgR20: r20.length ? Math.round(1e5 * r20.reduce((s, x) => s + x.r20, 0) / r20.length) / 1e5 : null,
    };
  };
  // 逐層累加過濾
  let pool = track.slice();
  const ladder = [];
  for (const [label, fn] of gates) {
    pool = pool.filter((x) => {
      const r = dateOf.get(x.date + '|' + x.ticker);
      return r ? fn(r) : false;
    });
    ladder.push({ gate: label, ...statOf(pool) });
  }
  // 分數分位：每日按 net_ev 排名，睇頭 1 名 vs 尾 1 名嘅實際表現
  const byD = track.reduce((m, x) => ((m[x.date] ||= []).push(x), m), {});
  const tops = [], bottoms = [];
  for (const d of Object.keys(byD)) {
    const arr = byD[d].slice().sort((a, b) => b.net_ev - a.net_ev);
    if (arr.length >= 3) { tops.push(arr[0]); bottoms.push(arr[arr.length - 1]); }
  }
  return {
    ladder,
    rankEdge: { top1: statOf(tops), bottom1: statOf(bottoms) },
    bySide: { buy: statOf(track.filter((x) => x.side === 1)), sell: statOf(track.filter((x) => x.side === -1)) },
  };
}

if (process.argv[1] && process.argv[1].endsWith('engine.mjs')) {
  const res = run();
  const outDir = path.join(ROOT, 'docs', 'data');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'dashboard.json'), JSON.stringify(res, null, 1));
  console.log(`質量（${res.pmfxDate}）: ${res.quality.total} 標的 | 引擎異常 ${res.quality.err} | RR 無效 ${res.quality.rrvInvalid} | 止損退化 ${res.quality.degenerate} | 通過 ${res.quality.clean}`);
  console.log('\n=== Gate 階梯（每加一層 filter 之後嘅實際前向表現）===');
  console.log('gate                     n   已結算  勝率%   avgR5%    avgR20%');
  for (const g of res.audit.ladder)
    console.log(`${g.gate.padEnd(22)}${String(g.n).padStart(5)}${String(g.decided).padStart(7)}${String(g.winRate).padStart(8)}${String(g.avgR5).padStart(9)}${String(g.avgR20).padStart(10)}`);
  console.log('\n=== 排名有冇 edge？（每日 net_ev 頭 1 vs 尾 1）===');
  console.log('  頭1名:', JSON.stringify(res.audit.rankEdge.top1));
  console.log('  尾1名:', JSON.stringify(res.audit.rankEdge.bottom1));
  console.log('  做多  :', JSON.stringify(res.audit.bySide.buy));
  console.log('  做空  :', JSON.stringify(res.audit.bySide.sell));
  console.log('\nTIER A/B（可執行候選）:');
  const show = res.opportunities.filter((o) => ['A', 'B'].includes(o.tier)).slice(0, 10);
  console.log('ticker      act  net_ev   rr  止損%  共識  tier  score');
  for (const o of show)
    console.log(`${o.ticker.padEnd(11)}${String(o.action).padEnd(5)}${String(o.net_ev).padStart(7)}${String(o.rr).padStart(6)}${String(o.stopPct).padStart(7)}${String(o.cons).padStart(6)}   ${o.tier}   ${o.score}`);
  console.log('\n前向追蹤（乾淨訊號）:', JSON.stringify(res.trackingStats.clean));
  console.log('前向追蹤（全部）  :', JSON.stringify(res.trackingStats.all));
  console.log(`\n已寫 docs/data/dashboard.json (${(fs.statSync(path.join(outDir, 'dashboard.json')).size / 1024).toFixed(0)} KB)`);
}
