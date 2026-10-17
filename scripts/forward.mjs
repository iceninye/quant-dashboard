// forward.mjs — 港股低 MDD 前向紀錄（forward log）
//
// 目的：回測有倖存者偏差（universe = 當日最活躍名單），唯一無偏差嘅證據係「事前凍結規則、事後照記」。
// 規則一經凍結（RULE），改動就要升 version，舊紀錄唔重寫。
//   訊號 : 簽名日（liveFrom + 28k 日曆日，取當日或之前最後一個港股數據日）按 repo 嘅 `mdd` 欄（越接近 0 越好）揀頭 TOP 隻
//   入場 : 訊號日之後第一個港股數據日收市（t+1）
//   持有 : 到下一個簽名日嘅入場日
//   成本 : COST_BPS × 單邊換手（第一期全倉買入 = 1）
//   對手 : 同日兩端都有價嘅全部標的等權（唔扣成本）
// 訊號只用訊號日當日數據，所以遲咗 build 都可以重現；`built_at` 同 `late` 記低有冇事後補。
import fs from 'node:fs';
import { parseCsv, toCsv, num } from './lib/csv.mjs';

export const RULE = { version: 'hk-lowmdd-v1', liveFrom: '2026-10-16', top: 10, stepDays: 28, costBps: 30, minNames: 30 };
export const LOG_COLS = ['signal_date', 'rule', 'tickers', 'built_at', 'late'];
const DAY = 86400000;
const addDays = (d, k) => new Date(Date.parse(d) + k * DAY).toISOString().slice(0, 10);
const diffDays = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const r4 = (v) => (v === null ? null : Math.round(v * 1e4) / 1e4);

// 簽名日：liveFrom + 28k，取該日或之前最後一個數據日；若該數據日距理論日 > 4 日 → 缺數據，跳過
export function signalDates(dates, rule = RULE) {
  if (!dates.length) return [];
  const last = dates[dates.length - 1];
  const out = [];
  for (let k = 0; addDays(rule.liveFrom, k * rule.stepDays) <= last; k++) {
    const target = addDays(rule.liveFrom, k * rule.stepDays);
    const cand = dates.filter((d) => d <= target).at(-1);
    if (cand && cand >= rule.liveFrom && diffDays(cand, target) <= 4) out.push({ target, date: cand });
  }
  return out;
}

export function pick(rows, date, rule = RULE) {
  const day = rows.filter((r) => r.date === date && num(r.mdd) !== null && num(r.close) > 0);
  if (day.length < rule.minNames) return null;
  return day.sort((a, b) => num(b.mdd) - num(a.mdd) || (a.ticker < b.ticker ? -1 : 1)).slice(0, rule.top).map((r) => r.ticker);
}

export function readLog(file) {
  return fs.existsSync(file) ? parseCsv(fs.readFileSync(file, 'utf8')) : [];
}

// 純計算：返回 { summary, newRows }；唔寫檔
export function forwardLog(hkRows, existing = [], builtAt = new Date().toISOString().slice(0, 10), rule = RULE) {
  const dates = [...new Set(hkRows.map((r) => r.date))].sort();
  const px = new Map();
  for (const r of hkRows) {
    const c = num(r.close);
    if (c > 0) (px.get(r.date) || px.set(r.date, new Map()).get(r.date)).set(r.ticker, c);
  }
  const sigs = signalDates(dates, rule);
  const have = new Map(existing.map((r) => [r.signal_date, r]));
  const newRows = [];
  const mismatches = [];
  const items = [];
  for (const s of sigs) {
    const t = pick(hkRows, s.date, rule);
    if (!t) continue;
    const logged = have.get(s.date);
    if (logged) { if (logged.tickers !== t.join(' ')) mismatches.push(s.date); }
    else newRows.push({ signal_date: s.date, rule: rule.version, tickers: t.join(' '), built_at: builtAt, late: diffDays(s.date, builtAt) > 4 ? '1' : '0' });
    items.push({ date: s.date, tickers: logged ? logged.tickers.split(' ') : t, late: logged ? logged.late === '1' : diffDays(s.date, builtAt) > 4 });
  }
  const entryOf = (d) => dates.find((x) => x > d) || null;
  let prev = null;
  const periods = items.map((it, i) => {
    const entry = entryOf(it.date), nxt = items[i + 1] ? entryOf(items[i + 1].date) : null;
    const p = { signalDate: it.date, entry, exit: nxt, tickers: it.tickers, late: it.late, status: !entry ? 'pending-entry' : !nxt ? 'open' : 'settled' };
    if (entry && nxt) {
      const a = px.get(entry), b = px.get(nxt);
      const rets = it.tickers.map((t) => (a.has(t) && b.has(t) ? b.get(t) / a.get(t) - 1 : null)).filter((x) => x !== null);
      const all = [...a.keys()].filter((t) => b.has(t)).map((t) => b.get(t) / a.get(t) - 1);
      const overlap = prev ? it.tickers.filter((t) => prev.includes(t)).length : 0;
      const turnover = prev ? 1 - overlap / it.tickers.length : 1;
      const cost = turnover * rule.costBps / 1e4;
      if (rets.length && all.length) {
        const g = rets.reduce((s, x) => s + x, 0) / rets.length, bm = all.reduce((s, x) => s + x, 0) / all.length;
        Object.assign(p, { gross: r4(g), cost: r4(cost), net: r4(g - cost), bench: r4(bm), excess: r4(g - cost - bm), turnover: r4(turnover), names: rets.length });
      }
    }
    prev = it.tickers;
    return p;
  });
  const done = periods.filter((p) => p.excess !== undefined);
  const ex = done.map((p) => p.excess);
  const m = ex.length ? ex.reduce((s, x) => s + x, 0) / ex.length : null;
  const sd = ex.length > 1 ? Math.sqrt(ex.reduce((s, x) => s + (x - m) ** 2, 0) / (ex.length - 1)) : null;
  const summary = {
    rule, settled: done.length, periods,
    meanExcess: r4(m), sdExcess: r4(sd),
    t: sd ? Math.round(100 * m / sd * Math.sqrt(ex.length)) / 100 : null,
    // 6 年回測每期超額 +1.16%、sd 約 5.45% → |t|=2 需約 89 期；以現時 forward 平均／sd 推算只作參考
    needed: m && sd ? Math.ceil((2 * sd / Math.abs(m)) ** 2) : null,
    mismatches, lateCount: items.filter((x) => x.late).length,
  };
  return { summary, newRows };
}

export function appendLog(file, newRows) {
  if (!newRows.length) return;
  fs.mkdirSync(file.replace(/[/\\][^/\\]*$/, ''), { recursive: true });
  const exists = fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim().length > 0;
  const body = toCsv(LOG_COLS, newRows);
  fs.appendFileSync(file, exists ? body.split('\n').slice(1).join('\n') : body);
}
