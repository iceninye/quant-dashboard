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
import { priceSeries, validateFactors, picksFor } from './factors.mjs';
import { forwardLog, readLog, appendLog, evaluateLogged, readAnchors, checkAnchor } from './forward.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORWARD_FILE = path.join(ROOT, 'data', 'forward', 'hk-lowmdd.csv');
const FORWARD_V2_FILE = path.join(ROOT, 'data', 'forward', 'hk-lowmdd-252.csv');
const PMFX_FIXED_FROM = '2026-10-17';
export const CFG = {
  minStopPct: 0.3,     // 止損距離 < 0.3% 視為退化（今日 BTC-USD 得 0.1%）
  maxStopPct: 12,      // 止損 > 12% 唔算「短線機會」
  minRR: 1.0,
  minNetEv: 0,
  costPct: 0.2,        // 來回交易成本（%），前向回報一律扣除
  fillDays: 20,        // 限價 entry 要喺幾多個交易日內被收市價觸及先算成交
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
function loadBackfill() {
  const f = path.join(ROOT, 'data', 'backfill', 'closes.csv');
  return fs.existsSync(f) ? parseCsv(fs.readFileSync(f, 'utf8')) : [];
}
export function loadAll() {
  const fam = {};
  for (const f of ['hk', 'us', 'sentinel', 'pmfx', 'macro']) fam[f] = loadFamily(f);
  fam.backfill = loadBackfill();   // 只有 date/ticker/close，唔畀訊號用
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
  const rr = n(row.rr), ev = n(row.net_ev), sp = n(row.stop_pct) === null ? null : Math.abs(n(row.stop_pct));  // 舊數據做空 stop_pct 係負數
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
// PMFX 嘅 entry 係限價（做空平均高過收市 ~7.6%、做多低過 ~4.4%），唔係市價。
// 所以：之後收市價觸及 entry 先算成交（fillDays 內），回報由成交日起計、扣 costPct；
// 未成交 = 'unfilled'，唔計回報。entry == close 嘅訊號即係市價，t+1 收市成交。
export function forwardTrack(fam) {
  const pm = byDate(fam.pmfx);
  const dates = Object.keys(pm).sort();
  const px = new Map();                    // ticker → [[date, close], ...]
  for (const [t, ser] of priceMap(fam)) px.set(t, ser.dates.map((d, i) => [d, ser.px[i]]));
  const cost = CFG.costPct / 100;
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
      // 成交：收市價觸及限價 entry（做多 ≤ entry、做空 ≥ entry）
      let fill = -1;
      for (let k = 0; k < Math.min(series.length, CFG.fillDays); k++)
        if (side === 1 ? series[k][1] <= entry : series[k][1] >= entry) { fill = k; break; }
      const after = fill < 0 ? [] : series.slice(fill + 1);
      const ret = (k) => {
        if (fill < 0 || after.length < k) return null;
        return side * (after[k - 1][1] - entry) / entry - cost;
      };
      let outcome = 'pending', hitDay = null;
      if (fill < 0) outcome = series.length >= CFG.fillDays ? 'unfilled' : 'pending';
      else {
        for (let k = 0; k < Math.min(after.length, 20); k++) {
          const [, c] = after[k];
          const hitT = tgt !== null && (side === 1 ? c >= tgt : c <= tgt);
          const hitS = stp !== null && (side === 1 ? c <= stp : c >= stp);
          if (hitT) { outcome = 'target'; hitDay = fill + k + 2; break; }
          if (hitS) { outcome = 'stop'; hitDay = fill + k + 2; break; }
        }
        if (outcome === 'pending' && after.length >= 20) outcome = 'timeout';
      }
      out.push({
        date: d, ticker: r.ticker, name: r.name, side, action: r.action,
        entry, rr: n(r.rr), net_ev: ev, stopPct: n(r.stop_pct),
        clean: q.ok, filled: fill >= 0, fillDay: fill < 0 ? null : fill + 1, outcome, hitDay,
        r1: ret(1), r5: ret(5), r10: ret(10), r20: ret(20),
        daysObserved: series.length,
      });
    }
  }
  return out;
}

// ---------- 價格來源 ----------
// HK / US quant 嘅收市價優先：PMFX 有約 4% 行嘅 close 係上一行數據（只跑咗 07:15 嗰次），
// 用佢做前向追蹤會造出一日假波動。PMFX 只補 quant 冇嘅標的（FX、期貨、加密）。
export function priceMap(fam) {
  const m = priceSeries(fam.pmfx || []);
  for (const [t, s] of priceSeries([...(fam.hk || []), ...(fam.us || []), ...(fam.backfill || [])])) m.set(t, s);
  return m;
}

// ---------- 數據核對：每次 build 都重算，結果放上 dashboard ----------
export function dataAudit(fam) {
  const issues = [];
  const splits = [];
  priceSeries([...(fam.hk || []), ...(fam.us || [])], splits);
  for (const e of splits) issues.push({ level: 'info', fam: e.ticker.endsWith('.HK') ? 'hk' : 'us', msg: `${e.ticker} ${e.from} → ${e.to} 疑似 ${e.k}:1 拆股（單日跌幅 > 30% 而且前後價比 ≈ ${e.k}），前向回報已按拆股調整` });
  const fams = ['hk', 'us', 'sentinel', 'pmfx', 'macro'];
  const cov = fams.map((f) => {
    const ds = [...new Set(fam[f].map((r) => r.date))].sort();
    const gaps = [];
    for (let i = 1; i < ds.length; i++) {
      const g = (Date.parse(ds[i]) - Date.parse(ds[i - 1])) / 86400000;
      if (g > 7) gaps.push({ from: ds[i - 1], to: ds[i], days: g });
    }
    const dup = fam[f].length - new Set(fam[f].map((r) => r.date + '|' + (r.ticker || ''))).size;
    const cols = fam[f].length ? Object.keys(fam[f][0]).filter((c) => c !== 'date') : [];
    const empty = cols.filter((c) => fam[f].every((r) => r[c] === ''));
    return { fam: f, rows: fam[f].length, days: ds.length, first: ds[0] || null, last: ds.at(-1) || null, gaps, dup, empty };
  });
  for (const c of cov) {
    for (const g of c.gaps) {
      const bf = !['hk', 'us'].includes(c.fam) ? 0 : new Set((fam.backfill || []).filter((r) => r.date > g.from && r.date < g.to).map((r) => r.date)).size;
      issues.push(bf >= 3
        ? { level: 'info', fam: c.fam, msg: `${g.from} → ${g.to} 缺 ${g.days} 日訊號數據；收市價已由 backfill 補 ${bf} 日，持有期可計（呢段冇訊號、冇 mdd 等欄，上游當日冇跑，冇得重建）` }
        : { level: 'warn', fam: c.fam, msg: `${g.from} → ${g.to} 缺 ${g.days} 日數據（上游當日冇產出報告，冇得補）；跨越呢段嘅持有期唔計` });
    }
    if (c.dup) issues.push({ level: 'bad', fam: c.fam, msg: `${c.dup} 行重複 (date, ticker)` });
    const PENDING = {   // 上游已修、等本機部署嘅欄位（部署後新數據有值，警告會自動消失）
      'us|beta': 'quant-us 原本用 SPY 做基準但 SPY 唔喺 most-active 名單 → 全部 NaN；src/quant-us/src/main.py 已改為另外下載基準。beta 唔影響任何因子',
      'sentinel|close': 'Sentinel CSV 原本冇輸出收市價；src/sentinel/src/core.py 已加 last_price。期間 Sentinel 因子用 HK/US quant 收市價，唔受影響',
    };
    for (const col of c.empty) {
      const why = PENDING[c.fam + '|' + col];
      issues.push({ level: 'warn', fam: c.fam, msg: `欄位全空：${col}${why ? `（${why}；要喺本機部署修正）` : ''}` });
    }
  }
  // PMFX close vs quant close（同日同標的）
  const q = new Map();
  for (const r of [...fam.hk, ...fam.us]) q.set(r.date + '|' + r.ticker, n(r.close));
  let both = 0, off = 0;
  const offDates = new Set();
  for (const r of fam.pmfx) {
    const a = n(r.close), b = q.get(r.date + '|' + r.ticker);
    if (a === null || b === null || b === undefined) continue;
    both++;
    if (Math.abs(a / b - 1) > 0.01) { off++; offDates.add(r.date); }
  }
  if (off) issues.push({ level: 'info', fam: 'pmfx', msg: `${off}/${both} 行 close 同 quant 相差 > 1%（${[...offDates].sort().join('、')}），係上一行數據；前向追蹤已改用 quant 收市價` });
  const pmErr = fam.pmfx.filter((r) => r.err === '1');
  if (pmErr.length) {
    const ds = [...new Set(pmErr.map((r) => r.date))].sort();
    const latest = latestDate(fam.pmfx), nowErr = fam.pmfx.filter((r) => r.date === latest && r.err === '1').length;
    issues.push(nowErr
      ? { level: 'bad', fam: 'pmfx', msg: `${pmErr.length}/${fam.pmfx.length} 行 error 欄非空（${ds[0]} 至 ${ds.at(-1)}），最新一日 ${latest} 仍有 ${nowErr} 行，PMFX 數值唔可信` }
      : { level: 'warn', fam: 'pmfx', msg: `${pmErr.length}/${fam.pmfx.length} 行 error 欄非空（${ds[0]} 至 ${ds.at(-1)}，上游 bug），最新一日 ${latest} 已冇 error；歷史行由 gate 排除，所以 PMFX 仲未有可用嘅歷史樣本（冇得補）` });
  }
  const usNull = fam.us.filter((r) => r.close === '');
  if (usNull.length) {
    const ds = [...new Set(usNull.map((r) => r.date))];
    const bfk = new Set((fam.backfill || []).map((r) => r.date + '|' + r.ticker));
    const left = usNull.filter((r) => !bfk.has(r.date + '|' + r.ticker)).length;
    issues.push({ level: left ? 'warn' : 'info', fam: 'us', msg: `${usNull.length} 行 close 為空（${ds.join('、')}，上游當日抓價失敗）；backfill 補到 ${usNull.length - left} 行，其餘 ${left} 行因緊接嘅缺口內有除息，比例驗唔到所以唔補。只影響用呢日做入場／出場價嘅窗口` });
  }
  return { coverage: cov, issues };
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
  const factors = validateFactors(fam, priceMap(fam));
  const pmLatest = new Map(pmRows.map((r) => [r.ticker, r]));
  const fv1rows = readLog(FORWARD_FILE);
  const fl = forwardLog(fam.hk, fv1rows);
  const fv2 = readLog(FORWARD_V2_FILE);
  fl.summary.anchorIssue = checkAnchor(fv1rows, readAnchors(FORWARD_FILE)['hk-lowmdd.csv']);
  const forwardV2 = fv2.length ? evaluateLogged(fam.hk, fv2) : null;   // 影子紀錄：只評估已簽名單
  if (forwardV2) forwardV2.anchorIssue = checkAnchor(fv2, readAnchors(FORWARD_V2_FILE)['hk-lowmdd-252.csv']);
  // PMFX 修正後（2026-10-17 起）嘅乾淨訊號結算樣本；結算夠 needed 個先重新評估
  const newT = tracking.filter((x) => x.date >= PMFX_FIXED_FROM && x.clean && ['target', 'stop', 'timeout'].includes(x.outcome));
  const r5s = newT.filter((x) => x.r5 !== null).map((x) => x.r5);
  const pmfxNew = { since: PMFX_FIXED_FROM, settled: newT.length, needed: 20,
    avgR5: r5s.length ? Math.round(1e4 * r5s.reduce((a, b) => a + b, 0) / r5s.length) / 1e4 : null };
  const picks = picksFor(fam, factors, ctx.ctx.sen, pmLatest);
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
    factors, picks, forward: fl.summary, forwardNew: fl.newRows, forwardV2, pmfxNew,
    dataAudit: dataAudit(fam),
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
    ['+ 止損 ≥ 0.3%', (r) => Math.abs(n(r.stop_pct) ?? 0) >= CFG.minStopPct],
    ['+ 引擎無 error', (r) => r.err !== '1'],
    ['+ 止損 ≤ 5%', (r) => Math.abs(n(r.stop_pct) ?? 1e9) <= 5],
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
  appendLog(FORWARD_FILE, res.forwardNew);
  delete res.forwardNew;
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
  console.log('\n=== 因子驗證（t+1 入場、扣成本、頭 20% vs 等權）===');
  for (const f of res.factors) for (const h of f.byH)
    console.log(`${(f.marketLabel + ' ' + f.label).padEnd(26)} H=${String(h.H).padEnd(3)} 超額 ${(100 * h.excess).toFixed(2).padStart(6)}%  IS ${(100 * h.isExcess).toFixed(2).padStart(6)}%  OOS ${(100 * h.oosExcess).toFixed(2).padStart(6)}%  t ${String(h.t).padStart(5)}  adjP ${String(h.adjP).padStart(6)}  窗口 ${h.windows}  ${{ pass: '通過', watch: '觀察', fail: '—' }[h.grade]}`);
  console.log('\n數據核對:'); for (const i of res.dataAudit.issues) console.log(`  [${i.level}] ${i.fam}: ${i.msg}`);
  console.log('\n前向追蹤（乾淨訊號）:', JSON.stringify(res.trackingStats.clean));
  console.log('前向追蹤（全部）  :', JSON.stringify(res.trackingStats.all));
  console.log(`\n已寫 docs/data/dashboard.json (${(fs.statSync(path.join(outDir, 'dashboard.json')).size / 1024).toFixed(0)} KB)`);
}
