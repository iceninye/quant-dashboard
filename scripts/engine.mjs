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
import { shortTermScan } from './shortterm.mjs';
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
  // 交易幾何硬約束（P0-4）：全部用 ATR / R，唔用報價單位
  maxEntryAtr: 1,      // |entry − close| > 1×ATR 唔准入選（歷史中位：買 5%、沽 8% 遠離市價）
  minStopAtr: 1,       // |entry − stop| < 1×ATR = 噪音範圍內嘅止損
  rrMin: 1.5, rrMax: 3.0,
  // 勝率模型（P0-2）：歷史 forwardTrack 分層 → Wilson 下界，n 少就向打和勝率 1/(1+RR) 收縮
  pWinZ: 1.2816,       // 單尾 90%
  priorN: 4,           // Beta(2,2) 等效樣本數
  // 前向確認（P0-1，預註冊）：未達標 = 未驗證，fail closed
  confirm: { pmfxSettled: 20, fwdSettled: 8, fwdT: 2 },
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
// 本機搜過、確認冇得補嘅缺口（data/known_gaps.csv：fam,from,to,reason）。審計欄位由人確認，唔係引擎自己猜。
export function loadKnownGaps() {
  const f = path.join(ROOT, 'data', 'known_gaps.csv');
  return fs.existsSync(f) ? parseCsv(fs.readFileSync(f, 'utf8')) : [];
}
// 已確認上游抓錯嘅收市價更正（data/backfill/corrections.csv：date,ticker,close,source,reason）。原始 CSV 唔改，讀入時按 date|ticker 覆蓋 close。
export function loadCorrections() {
  const f = path.join(ROOT, 'data', 'backfill', 'corrections.csv');
  return fs.existsSync(f) ? parseCsv(fs.readFileSync(f, 'utf8')) : [];
}
export function applyCorrections(rows, corr) {
  if (!corr.length) return rows;
  const m = new Map(corr.map((c) => [c.date + '|' + c.ticker, c.close]));
  return rows.map((r) => (m.has(r.date + '|' + r.ticker) ? { ...r, close: m.get(r.date + '|' + r.ticker), close_raw: r.close } : r));
}
export function loadAll() {
  const fam = {};
  for (const f of ['hk', 'us', 'sentinel', 'pmfx', 'macro']) fam[f] = loadFamily(f);
  fam.corrections = loadCorrections();
  for (const f of ['hk', 'us']) fam[f] = applyCorrections(fam[f], fam.corrections);
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

// ---------- 交易幾何（P0-4）----------
// 由價格重算，唔信 PMFX 自報嘅 rr / stop_pct。entryAtr = 限價離市價幾多個 ATR。
export function geometry(row) {
  const side = sideOf(row.action);
  const close = n(row.close), entry = n(row.entry) || close, tgt = n(row.target), stp = n(row.stop), atr = n(row.atr);
  const fails = [];
  if (!side || !entry || tgt === null || stp === null) return { ok: false, fails: ['缺方向／entry／目標／止損'], rr: null };
  const risk = side * (entry - stp), reward = side * (tgt - entry);
  if (!(risk > 0) || !(reward > 0)) return { ok: false, fails: ['目標或止損喺錯邊'], rr: null };
  const g = { rr: reward / risk, stopPct: 100 * risk / entry, costR: (CFG.costPct / 100) * entry / risk,
    entryAtr: atr > 0 && close ? Math.abs(entry - close) / atr : null, stopAtr: atr > 0 ? risk / atr : null };
  if (g.entryAtr === null || g.stopAtr === null) fails.push('無 ATR，幾何驗唔到');
  else {
    if (g.entryAtr > CFG.maxEntryAtr) fails.push(`入場離市價 ${g.entryAtr.toFixed(1)}×ATR > ${CFG.maxEntryAtr}`);
    if (g.stopAtr < CFG.minStopAtr) fails.push(`止損 ${g.stopAtr.toFixed(2)}×ATR < ${CFG.minStopAtr}`);
  }
  if (g.rr < CFG.rrMin || g.rr > CFG.rrMax) fails.push(`RR ${g.rr.toFixed(2)} 唔喺 ${CFG.rrMin}–${CFG.rrMax}`);
  return { ok: fails.length === 0, fails, ...g };
}

// ---------- 勝率模型（P0-2）----------
// 舊 PMFX 勝率 = 0.50 + 加分，同 RR 脫鈎（corr ≈ 0），令 net_ev > 0 恆成立。
// 新：由 forwardTrack 已結算樣本（已成交且 target / stop / timeout）按幾何分層數 k / n；timeout 當輸（保守）。
// pWin = Wilson 下界(k + priorN·p0, n + priorN)，p0 = 1/(1+RR) 係打和勝率 → 冇樣本時 evR 一定 < 0（fail closed）。
export function wilsonLower(k, nn, z = CFG.pWinZ) {
  if (!(nn > 0)) return 0;
  const p = k / nn, z2 = z * z;
  return Math.max(0, (p + z2 / (2 * nn) - z * Math.sqrt(p * (1 - p) / nn + z2 / (4 * nn * nn))) / (1 + z2 / nn));
}
const cut = (v, edges) => (v === null || v === undefined ? 'na' : String(edges.filter((e) => v >= e).length));
export const bucketOf = (side, g) => [side, cut(g.rr, [1.5, 3, 6]), cut(g.stopPct, [2, 4, 8]), cut(g.entryAtr, [0.5, 1, 2])].join('|');
export function winModel(tracking) {
  const cells = new Map(), fills = new Map();
  for (const t of tracking) {
    if (!t.geo) continue;
    const fk = t.side + '|' + cut(t.geo.entryAtr, [0.5, 1, 2]);
    if (t.outcome !== 'pending') { const f = fills.get(fk) || { k: 0, n: 0 }; f.n++; if (t.filled) f.k++; fills.set(fk, f); }
    if (!t.filled || !['target', 'stop', 'timeout'].includes(t.outcome)) continue;
    const key = bucketOf(t.side, t.geo), c = cells.get(key) || { k: 0, n: 0 };
    c.n++; if (t.outcome === 'target') c.k++;
    cells.set(key, c);
  }
  const predict = (side, g) => {
    const c = cells.get(bucketOf(side, g)) || { k: 0, n: 0 };
    const p0 = 1 / (1 + g.rr);
    const pWin = wilsonLower(c.k + CFG.priorN * p0, c.n + CFG.priorN);
    const f = fills.get(side + '|' + cut(g.entryAtr, [0.5, 1, 2])) || { k: 0, n: 0 };
    const pFill = (f.k + 1) / (f.n + 2);                     // Beta(1,1)
    const evR = pWin * (g.rr + 1) - 1;
    return { pWin, p0, k: c.k, n: c.n, pFill, evR, rank: (evR - g.costR) * pFill };
  };
  return { cells, fills, predict };
}

// ---------- 機會評分 ----------
// 跨報告共識只作參考欄；排序同 tier 由 winModel 嘅 R 單位 EV 決定（P0-3：方向唔係 baseline 優勢）
export function score(row, ctx) {
  const { ctx: c } = ctx;
  const side = sideOf(row.action);                 // PMFX 方向
  let cons = 0, notes = [];
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
  // 舊 score = net_ev（報價單位）×共識 − 風險：同股價水平相關 0.65，已刪；排序改用 winModel rank（R 單位）
  return { cons: Math.round(cons * 100) / 100, notes, risk };
}

// tier 只由格式、幾何、R 單位 EV 同前向證據決定（P0-1/3）：
//   EXCLUDED = 過唔到 quality / 幾何 / evR − 成本 ≤ 0；CAND = 模型 EV > 0 但前向未確認；VERIFIED = 兩樣都過
export function tierOf(row, model, evidenceOk = false) {
  const q = quality(row);
  if (!q.ok) return { tier: 'EXCLUDED', why: q.fails };
  const g = geometry(row);
  if (!g.ok) return { tier: 'EXCLUDED', why: g.fails, geo: g };
  const m = model.predict(sideOf(row.action), g);
  if (m.evR - g.costR <= 0)
    return { tier: 'EXCLUDED', why: [`模型 EV ${(m.evR - g.costR).toFixed(2)}R ≤ 0（勝率下界 ${(100 * m.pWin).toFixed(1)}%，同類歷史 ${m.k}/${m.n}，打和要 ${(100 * m.p0).toFixed(1)}%）`], geo: g, m };
  if (!evidenceOk) return { tier: 'CAND', why: ['候選（未驗證）：PMFX 前向未確認'], geo: g, m };
  return { tier: 'VERIFIED', why: [], geo: g, m };
}

// ---------- 前向追蹤（唯一可以證明「機會」真定假）----------
// PMFX 嘅 entry 係限價（做空平均高過收市 ~7.6%、做多低過 ~4.4%），唔係市價。
// 所以：之後收市價觸及 entry 先算成交（fillDays 內），回報由成交日起計、扣 costPct；
// 未成交 = 'unfilled'，唔計回報。entry == close 嘅訊號即係市價，t+1 收市成交。
// 出場（P0-5）：stop-first —— 每根 bar 先查止損再查目標，成交當日都要查；止損用嗰日實際收市出場
// （跳空穿止損會蝕多過 1R），目標用目標價。repo 只有日收市、冇 high/low/open，所以做唔到真 intrabar：
// 收市冇觸及但盤中觸及嘅止損會漏計，結果仍然偏樂觀。
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
      const g = geometry(r);
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
      let outcome = 'pending', hitDay = null, exitPx = null;
      if (fill < 0) outcome = series.length >= CFG.fillDays ? 'unfilled' : 'pending';
      else {
        const path = series.slice(fill, fill + 21);          // 成交當日 + 之後 20 日
        for (let k = 0; k < path.length; k++) {
          const [, c] = path[k];
          if (stp !== null && (side === 1 ? c <= stp : c >= stp)) { outcome = 'stop'; exitPx = c; hitDay = fill + k + 1; break; }
          if (k > 0 && tgt !== null && (side === 1 ? c >= tgt : c <= tgt)) { outcome = 'target'; exitPx = tgt; hitDay = fill + k + 1; break; }
        }
        if (outcome === 'pending' && after.length >= 20) { outcome = 'timeout'; exitPx = after[19][1]; }
      }
      const risk = stp === null ? null : Math.abs(entry - stp);
      out.push({
        date: d, ticker: r.ticker, name: r.name, side, action: r.action,
        entry, rr: n(r.rr), net_ev: ev, stopPct: n(r.stop_pct),
        geo: g.rr === null ? null : { rr: g.rr, stopPct: g.stopPct, entryAtr: g.entryAtr, stopAtr: g.stopAtr },
        clean: q.ok, filled: fill >= 0, fillDay: fill < 0 ? null : fill + 1, outcome, hitDay,
        exitPx, R: exitPx === null || !risk ? null : side * (exitPx - entry) / risk - cost * entry / risk,
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
export function dataAudit(fam, opts = {}) {
  const issues = [];
  const known = opts.known || loadKnownGaps();
  const splits = [];
  priceSeries([...(fam.hk || []), ...(fam.us || [])], splits);
  for (const e of splits) issues.push({ level: 'info', fam: e.ticker.endsWith('.HK') ? 'hk' : 'us', msg: `${e.ticker} ${e.from} → ${e.to} 疑似 ${e.k}:1 拆股（單日跌幅 > 30% 而且前後價比 ≈ ${e.k}），前向回報已按拆股調整` });
  if ((fam.corrections || []).length) issues.push({ level: 'info', fam: 'hk', msg: `${fam.corrections.length} 行收市價已由 data/backfill/corrections.csv 更正（${[...new Set(fam.corrections.map((c) => c.date))].sort().join('、')} 上游抓咗上一交易日收市；原始 CSV 不動）` });
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
  // PMFX 上游 bug 時期（有 error 行嘅最後一日）：呢段嘅缺口，即使補到原檔都係 error 行，gate 一律排除
  const pmLastErr = fam.pmfx.filter((r) => r.err === '1').reduce((m, r) => (r.date > m ? r.date : m), '');
  const RECOVER = '本機有機會補到：node scripts/gap_sources.mjs 搵 mirror／iCloud archive／Obsidian 嘅原檔；搵唔到先算冇得補';
  for (const c of cov) {
    for (const g of c.gaps) {
      const bf = !['hk', 'us'].includes(c.fam) ? 0 : new Set((fam.backfill || []).filter((r) => r.date > g.from && r.date < g.to).map((r) => r.date)).size;
      const kg = known.find((k) => k.fam === c.fam && k.from === g.from && k.to === g.to);
      issues.push(kg
        ? { level: 'limit', fam: c.fam, msg: `${g.from} → ${g.to} 缺 ${g.days} 日數據：${kg.reason}（已喺本機搜過確認，見 data/known_gaps.csv）；跨越呢段嘅持有期唔計` }
        : c.fam === 'pmfx' && pmLastErr && g.to <= pmLastErr
          ? { level: 'limit', fam: c.fam, msg: `${g.from} → ${g.to} 缺 ${g.days} 日 PMFX 數據；呢段喺上游 bug 時期（至 ${pmLastErr}，行內 error 欄非空，gate 一律排除），即使補到原檔都用唔到，所以唔補` }
          : bf >= 3
            ? { level: 'info', fam: c.fam, msg: `${g.from} → ${g.to} 缺 ${g.days} 日訊號數據；收市價已由 backfill 補 ${bf} 日，持有期可計（呢段冇訊號、冇 mdd 等欄；唔事後重建，會用到未來數據；本機搵到原檔先可還原：node scripts/gap_sources.mjs）` }
            : { level: 'warn', fam: c.fam, msg: `${g.from} → ${g.to} 缺 ${g.days} 日數據（上游當日冇產出報告？）；跨越呢段嘅持有期唔計。${RECOVER}` });
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
    // 放寬測試：error 行但通過 gate 其餘規則嘅訊號，前向結果點？（證明 gate 唔係過嚴，而唔係靠估）
    const sens = (() => {
      const rows = new Map(fam.pmfx.map((r) => [r.date + '|' + r.ticker, r]));
      const sub = (opts.tracking || forwardTrack(fam)).filter((x) => { const r = rows.get(x.date + '|' + x.ticker); return !x.clean && r && r.err === '1' && quality({ ...r, err: '0' }).ok; });
      const filled = sub.filter((x) => x.filled), r5 = filled.filter((x) => x.r5 !== null).map((x) => x.r5);
      return r5.length ? { n: sub.length, filled: filled.length, avg: r5.reduce((a, b) => a + b, 0) / r5.length, pos: r5.filter((v) => v > 0).length, r5n: r5.length } : null;
    })();
    issues.push(nowErr
      ? { level: 'bad', fam: 'pmfx', msg: `${pmErr.length}/${fam.pmfx.length} 行 error 欄非空（${ds[0]} 至 ${ds.at(-1)}），最新一日 ${latest} 仍有 ${nowErr} 行，PMFX 數值唔可信` }
      : { level: 'limit', fam: 'pmfx', msg: `${pmErr.length}/${fam.pmfx.length} 行 error 欄非空（${ds[0]} 至 ${ds.at(-1)}，上游 bug，已修；最新一日 ${latest} 已冇 error）。歷史行冇得重新判斷：error 行嘅風險欄缺失、止損距離亦受影響，gate 一律排除。${sens ? `放寬測試：error 行但通過其餘 gate 規則嘅 ${sens.n} 個訊號，成交 ${sens.filled}，5 日平均 ${(100 * sens.avg).toFixed(2)}%，${sens.pos}/${sens.r5n} 為正 → 放寬都冇 edge，gate 唔算過嚴。` : ''}乾淨樣本要等新數據累積` });
  }
  const usNull = fam.us.filter((r) => r.close === '');
  if (usNull.length) {
    const ds = [...new Set(usNull.map((r) => r.date))];
    const bfk = new Set((fam.backfill || []).map((r) => r.date + '|' + r.ticker));
    const left = usNull.filter((r) => !bfk.has(r.date + '|' + r.ticker)).length;
    issues.push(left
      ? { level: 'warn', fam: 'us', msg: `${usNull.length} 行 close 為空（${ds.join('、')}，上游當日抓價失敗）；backfill 補到 ${usNull.length - left} 行，其餘 ${left} 行用復權價驗唔到比例（緊接缺口內有除息）。可補：本機 python3 analysis/download_raw_closes.py --market us，再 node scripts/backfill_prices.mjs --prices <輸出檔> --rebuild --apply（用未復權收市價，唔受除息影響，仍然要通過 0.3% 比例核對）。只影響用呢日做入場／出場價嘅窗口` }
      : { level: 'info', fam: 'us', msg: `${usNull.length} 行 close 為空（${ds.join('、')}，上游當日抓價失敗）；已由 backfill 補返，只影響用呢日做入場／出場價嘅窗口` });
  }
  return { coverage: cov, issues };
}

// ---------- 證據閘門（P0-1，fail closed）----------
// 「已驗證機會」= 歷史檢驗通過 且 前向確認。任何一樣未載入、未達標 → 唔係機會。
//   PMFX 卡：tier VERIFIED（winModel evR − 成本 > 0 且修正後前向結算 ≥ 20、平均 R > 0）
//   因子：grade pass 且有對應前向紀錄（而家只有港股低 MDD → hk-lowmdd-v1）結算 ≥ 8 期、t ≥ 2、鏈完整
export function evidenceGate({ factors, forward, forwardV2, pmfxNew, opportunities }) {
  const C = CFG.confirm;
  const fwdOk = (f) => !!f && f.settled >= C.fwdSettled && (f.t ?? 0) >= C.fwdT
    && !(f.chainBad || []).length && !(f.mismatches || []).length && !(f.future || []).length && !f.anchorIssue;
  const FWD_OF = { 'hk|mdd': forward };       // 因子 → 事前凍結嘅前向紀錄；冇對應 = 冇得確認
  const verified = [];
  for (const f of factors || []) {
    if (f.grade !== 'pass' || f.market === 'sentinel') continue;
    const fw = FWD_OF[f.market + '|' + f.key];
    if (fwdOk(fw)) verified.push({ kind: 'factor', label: f.marketLabel + ' ' + f.label });
  }
  for (const o of opportunities || []) if (o.tier === 'VERIFIED' && pmfxNew?.confirming) verified.push({ kind: 'pmfx', label: o.ticker });
  const inForward = [];
  if (forward?.rule) inForward.push({ rule: forward.rule.version, period: (forward.periods || []).length, settled: forward.settled, need: C.fwdSettled, confirming: fwdOk(forward) });
  return {
    verified, inForward,
    shadow: forwardV2 ? { settled: forwardV2.settled, periods: (forwardV2.periods || []).length } : null,
    candidates: (opportunities || []).filter((o) => o.tier === 'CAND').length,
    rule: C,
  };
}

// ---------- 組裝 ----------
export function run() {
  const fam = loadAll();
  const ctx = buildContext(fam);
  const pmRows = fam.pmfx.filter((r) => r.date === latestDate(fam.pmfx));
  const tracking = forwardTrack(fam);
  const model = winModel(tracking);
  // PMFX 修正後（2026-10-17 起）嘅乾淨訊號結算樣本；結算夠 needed 個先重新評估
  const newT = tracking.filter((x) => x.date >= PMFX_FIXED_FROM && x.clean && ['target', 'stop', 'timeout'].includes(x.outcome));
  const r5s = newT.filter((x) => x.r5 !== null).map((x) => x.r5);
  const Rs = newT.filter((x) => x.R !== null).map((x) => x.R);
  const pmfxNew = { since: PMFX_FIXED_FROM, settled: newT.length, needed: CFG.confirm.pmfxSettled,
    avgR5: r5s.length ? Math.round(1e4 * r5s.reduce((a, b) => a + b, 0) / r5s.length) / 1e4 : null,
    avgR: Rs.length ? Math.round(1e3 * Rs.reduce((a, b) => a + b, 0) / Rs.length) / 1e3 : null };
  pmfxNew.confirming = pmfxNew.settled >= pmfxNew.needed && pmfxNew.avgR !== null && pmfxNew.avgR > 0;
  const scored = pmRows.map((row) => {
    const sc = score(row, ctx);
    const t = tierOf(row, model, pmfxNew.confirming);
    const g = t.geo || geometry(row), m = t.m || (g.rr !== null ? model.predict(sideOf(row.action), g) : null);
    return {
      ticker: row.ticker, name: row.name, action: row.action,
      close: n(row.close), entry: n(row.entry), target: n(row.target), stop: n(row.stop),
      stopPct: n(row.stop_pct), rr: n(row.rr), net_rr: n(row.net_rr),
      ev: n(row.ev), net_ev: n(row.net_ev), atr: n(row.atr), votes: n(row.votes),
      opp: n(row.opp), source: row.source, sharpe: n(row.sharpe),
      err: row.err === '1', rrv: row.rrv === '1',
      cons: sc.cons, notes: sc.notes, risk: sc.risk,
      geoRr: g.rr, entryAtr: g.entryAtr ?? null, stopAtr: g.stopAtr ?? null, costR: g.costR ?? null,
      pWin: m ? m.pWin : null, p0: m ? m.p0 : null, histK: m ? m.k : null, histN: m ? m.n : null,
      pFill: m ? m.pFill : null, evR: m ? m.evR : null, rank: m ? m.rank : null,
      tier: t.tier, why: t.why,
      upPct: n(row.entry) && n(row.target) ? (sideOf(row.action) > 0
        ? (n(row.target) - n(row.entry)) / n(row.entry) * 100
        : (n(row.entry) - n(row.target)) / n(row.entry) * 100) : null,
    };
  });
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
      medR: (() => { const R = arr.filter((x) => x.R !== null && x.R !== undefined).map((x) => x.R).sort((a, b) => a - b);
        return R.length ? Math.round(100 * (R.length % 2 ? R[(R.length - 1) / 2] : (R[R.length / 2 - 1] + R[R.length / 2]) / 2)) / 100 : null; })(),
    };
  };
  const qual = {
    date: latestDate(fam.pmfx),
    total: pmRows.length,
    err: pmRows.filter((r) => r.err === '1').length,
    rrvInvalid: pmRows.filter((r) => r.rrv !== '1').length,
    degenerate: pmRows.filter((r) => { const sp = n(r.stop_pct); return sp !== null && sp < CFG.minStopPct; }).length,
    noStop: pmRows.filter((r) => n(r.stop_pct) === null).length,
    formatOk: pmRows.filter((r) => quality(r).ok).length,       // 只過格式 gate（舊「通過」定義）
    geoOk: pmRows.filter((r) => quality(r).ok && geometry(r).ok).length,
    clean: scored.filter((x) => x.tier !== 'EXCLUDED').length,  // 格式 + 幾何 + 模型 EV 都過
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
  const evidence = evidenceGate({ factors, forward: fl.summary, forwardV2, pmfxNew, opportunities: scored });
  const picks = picksFor(fam, factors, ctx.ctx.sen, pmLatest);
  return {
    generatedAt: new Date().toISOString(),
    dates: ctx.dates, pmfxDate: latestDate(fam.pmfx), macro,
    cfg: CFG,
    quality: qual,
    opportunities: scored.sort((a, b) => (a.tier === 'EXCLUDED') - (b.tier === 'EXCLUDED') || (b.rank ?? -1e9) - (a.rank ?? -1e9)),
    evidence,
    tracking,
    trackingStats: { clean: stat(byTier('clean')), all: stat(tracking) },
    audit: audit(fam, tracking),
    series: buildSeries(fam),
    factors, picks, shortTerm: shortTermScan(fam, CFG.costPct), forward: fl.summary, forwardNew: fl.newRows, forwardV2, pmfxNew,
    dataAudit: dataAudit(fam, { tracking }),
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
  console.log(`質量（${res.pmfxDate}）: ${res.quality.total} 標的 | 引擎異常 ${res.quality.err} | RR 無效 ${res.quality.rrvInvalid} | 止損退化 ${res.quality.degenerate} | 過格式 ${res.quality.formatOk} | 過幾何 ${res.quality.geoOk} | 模型 EV > 0 ${res.quality.clean}`);
  console.log('\n=== Gate 階梯（每加一層 filter 之後嘅實際前向表現）===');
  console.log('gate                     n   已結算  勝率%   avgR5%    avgR20%');
  for (const g of res.audit.ladder)
    console.log(`${g.gate.padEnd(22)}${String(g.n).padStart(5)}${String(g.decided).padStart(7)}${String(g.winRate).padStart(8)}${String(g.avgR5).padStart(9)}${String(g.avgR20).padStart(10)}`);
  console.log('\n=== 排名有冇 edge？（每日 net_ev 頭 1 vs 尾 1）===');
  console.log('  頭1名:', JSON.stringify(res.audit.rankEdge.top1));
  console.log('  尾1名:', JSON.stringify(res.audit.rankEdge.bottom1));
  console.log('  做多  :', JSON.stringify(res.audit.bySide.buy));
  console.log('  做空  :', JSON.stringify(res.audit.bySide.sell));
  const ev = res.evidence;
  console.log(`\n證據閘門：已驗證機會 ${ev.verified.length} 個；前向測試 ${ev.inForward.map((f) => `${f.rule} 第 ${f.period} 期（已結算 ${f.settled}/${f.need}）`).join('、') || '冇'}；PMFX 候選（未驗證）${ev.candidates}`);
  console.log('\nPMFX 今日（按 R 單位 rank；EXCLUDED 排尾）:');
  console.log('ticker      act    RR  入場/ATR 止損/ATR  pWin%  打和%   evR     rank   tier');
  const f2 = (v, d = 2) => (v === null || v === undefined ? '—' : v.toFixed(d));
  for (const o of res.opportunities.slice(0, 12))
    console.log(`${o.ticker.padEnd(11)}${String(o.action).padEnd(4)}${f2(o.geoRr).padStart(6)}${f2(o.entryAtr, 1).padStart(9)}${f2(o.stopAtr).padStart(8)}${f2(o.pWin === null ? null : 100 * o.pWin, 1).padStart(7)}${f2(o.p0 === null ? null : 100 * o.p0, 1).padStart(7)}${f2(o.evR).padStart(7)}${f2(o.rank, 3).padStart(9)}   ${o.tier}`);
  console.log('\n=== 因子驗證（t+1 入場、扣成本、頭 20% vs 等權）===');
  for (const f of res.factors) for (const h of f.byH)
    console.log(`${(f.marketLabel + ' ' + f.label).padEnd(26)} H=${String(h.H).padEnd(3)} 超額 ${(100 * h.excess).toFixed(2).padStart(6)}%  IS ${(100 * h.isExcess).toFixed(2).padStart(6)}%  OOS ${(100 * h.oosExcess).toFixed(2).padStart(6)}%  t ${String(h.t).padStart(5)}  adjP ${String(h.adjP).padStart(6)}  窗口 ${h.windows}  ${{ pass: '通過', watch: '觀察', fail: '—' }[h.grade]}`);
  console.log('\n數據核對:'); for (const i of res.dataAudit.issues) console.log(`  [${i.level}] ${i.fam}: ${i.msg}`);
  console.log('\n前向追蹤（乾淨訊號）:', JSON.stringify(res.trackingStats.clean));
  console.log('前向追蹤（全部）  :', JSON.stringify(res.trackingStats.all));
  console.log(`\n已寫 docs/data/dashboard.json (${(fs.statSync(path.join(outDir, 'dashboard.json')).size / 1024).toFixed(0)} KB)`);
}
