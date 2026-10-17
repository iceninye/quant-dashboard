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
import crypto from 'node:crypto';
import { parseCsv, toCsv, num } from './lib/csv.mjs';

export const RULE = { version: 'hk-lowmdd-v1', liveFrom: '2026-10-16', top: 10, stepDays: 28, costBps: 30, minNames: 30 };
// 影子紀錄 v2：訊號改用 trailing 252 日最大回撤（對應 WFO 6 年樣本 4 個 fold 全部揀中嘅 W）。
// repo 得約 63 個港股交易日，算唔到，所以由本機 prices 檔簽名（scripts/sign_v2.mjs）；其餘規則同 v1 完全一樣。
export const RULE_V2 = { ...RULE, version: 'hk-lowmdd-252-v1', window: 252 };
export const LOG_COLS = ['signal_date', 'rule', 'tickers', 'mdd_hash', 'built_at', 'late', 'prev_hash', 'hash'];
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex').slice(0, 16);
// 輸入指紋：頭 N 隻嘅 ticker:mdd（排序後）。用嚟分「上游 restate」同「紀錄被改」
export const mddHash = (rows, date, tickers) => {
  const m = new Map(rows.filter((r) => r.date === date).map((r) => [r.ticker, r.mdd]));
  return sha(tickers.slice().sort().map((t) => `${t}:${Number(m.get(t)).toFixed(6)}`).join('|'));
};
// 鏈：hash = sha(prev_hash | 全部欄位)；任何一欄被改、行被插入／刪走都會斷鏈。
// 只防意外同無心改動；有人重算整條鏈就要靠 git history 做最終錨點。
export const rowHash = (r, prev) => sha([prev, r.signal_date, r.rule, r.tickers, r.mdd_hash, r.built_at, r.late].join('|'));
export function verifyChain(rows) {
  let prev = '', bad = [];
  rows.forEach((r) => { if (r.prev_hash !== prev || r.hash !== rowHash(r, prev)) bad.push(r.signal_date); prev = r.hash; });
  return bad;
}
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

function priceIndex(hkRows) {
  const px = new Map();
  for (const r of hkRows) {
    const c = num(r.close);
    if (c > 0) (px.get(r.date) || px.set(r.date, new Map()).get(r.date)).set(r.ticker, c);
  }
  return px;
}

// 只評估紀錄入面已簽嘅名單（唔重算訊號）：用喺 v2 呢類 repo 內重算唔到訊號嘅紀錄
export function evaluateLogged(hkRows, logRows, rule = RULE_V2) {
  const dates = [...new Set(hkRows.map((r) => r.date))].sort();
  const mine = logRows.filter((r) => r.rule === rule.version).sort((a, b) => (a.signal_date < b.signal_date ? -1 : 1));
  const items = mine.map((r) => ({ date: r.signal_date, tickers: r.tickers.split(' '), late: r.late === '1' }));
  const future = logRows.filter((r) => r.signal_date > (dates.at(-1) || '')).map((r) => r.signal_date);
  return summarize(dates, priceIndex(hkRows), items, rule, { chainBad: verifyChain(logRows), future, mismatches: [], unverifiable: true });
}

// 由本機 prices 寬表（首欄日期、其餘欄 ticker，已復權）簽 trailing-window MDD 名單。
// 只用簽名日及之前嘅數據；universe = 簽名日 repo 內有收市價嘅港股 ∩ prices 檔欄位（時點一致，冇倖存者偏差）。
// MDD 係比例，整份歷史乘同一常數（之後除息嘅復權）唔影響結果，所以用較遲嘅快照簽舊日期亦重現到。
export function signWindowed(wide, hkRows, existing = [], builtAt = new Date().toISOString().slice(0, 10), rule = RULE_V2) {
  const dcol = Object.keys(wide[0] || {})[0];
  const rows = wide.map((r) => ({ ...r, __d: String(r[dcol]).slice(0, 10) })).sort((a, b) => (a.__d < b.__d ? -1 : 1));
  const dates = [...new Set(hkRows.map((r) => r.date))].sort();
  const have = new Set(existing.filter((r) => r.rule === rule.version).map((r) => r.signal_date));
  let tail = existing.length ? existing.at(-1).hash : '';
  const newRows = [], skipped = [];
  for (const s of signalDates(dates, rule)) {
    if (have.has(s.date)) continue;
    const upto = rows.filter((r) => r.__d <= s.date);
    if (upto.at(-1)?.__d !== s.date) { skipped.push({ date: s.date, reason: 'prices 檔冇簽名日當日數據' }); continue; }
    const win = upto.slice(-rule.window);
    if (win.length < rule.window) { skipped.push({ date: s.date, reason: `prices 只有 ${win.length} 日，唔夠 ${rule.window}` }); continue; }
    const live = new Set(hkRows.filter((r) => r.date === s.date && num(r.close) > 0).map((r) => r.ticker));
    const mdds = [];
    for (const t of live) {
      const ps = win.map((r) => num(r[t]));
      if (ps.some((x) => !(x > 0))) continue;                      // 窗口內有缺 → 唔入選，唔補值
      let peak = 0, mn = 0;
      for (const x of ps) { peak = Math.max(peak, x); mn = Math.min(mn, x / peak - 1); }
      mdds.push({ date: s.date, ticker: t, mdd: mn });
    }
    if (mdds.length < rule.minNames) { skipped.push({ date: s.date, reason: `可計 MDD 嘅股票只有 ${mdds.length}` }); continue; }
    const top = mdds.sort((a, b) => b.mdd - a.mdd || (a.ticker < b.ticker ? -1 : 1)).slice(0, rule.top).map((x) => x.ticker);
    const r = { signal_date: s.date, rule: rule.version, tickers: top.join(' '), mdd_hash: mddHash(mdds, s.date, top), built_at: builtAt, late: diffDays(s.date, builtAt) > 4 ? '1' : '0', prev_hash: tail };
    r.hash = rowHash(r, tail); tail = r.hash; newRows.push(r);
  }
  return { newRows, skipped };
}

export function readLog(file) {
  return fs.existsSync(file) ? parseCsv(fs.readFileSync(file, 'utf8')) : [];
}

// 純計算：返回 { summary, newRows }；唔寫檔
export function forwardLog(hkRows, existing = [], builtAt = new Date().toISOString().slice(0, 10), rule = RULE) {
  const dates = [...new Set(hkRows.map((r) => r.date))].sort();
  const px = priceIndex(hkRows);
  const sigs = signalDates(dates, rule);
  const chainBad = verifyChain(existing);
  const lastDate = dates.at(-1) || '';
  const future = existing.filter((r) => r.signal_date > lastDate).map((r) => r.signal_date);
  const have = new Map(existing.filter((r) => r.rule === rule.version).map((r) => [r.signal_date, r]));
  let tail = existing.length ? existing.at(-1).hash : '';
  const newRows = [];
  const mismatches = [];
  const items = [];
  for (const s of sigs) {
    const t = pick(hkRows, s.date, rule);
    if (!t) continue;
    const logged = have.get(s.date);
    const mh = mddHash(hkRows, s.date, t);
    if (logged) {
      const sameT = logged.tickers === t.join(' '), sameH = logged.mdd_hash === mh;
      // 名單同輸入都變 / 淨輸入變 = 上游 restate（或兩邊一齊被改）；輸入唔變但名單變 = 紀錄被改
      if (!sameT || !sameH) mismatches.push({ date: s.date, kind: sameT ? 'input-restated' : sameH ? 'log-edited' : 'restated' });
    } else {
      const r = { signal_date: s.date, rule: rule.version, tickers: t.join(' '), mdd_hash: mh, built_at: builtAt, late: diffDays(s.date, builtAt) > 4 ? '1' : '0', prev_hash: tail };
      r.hash = rowHash(r, tail); tail = r.hash; newRows.push(r);
    }
    items.push({ date: s.date, tickers: logged ? logged.tickers.split(' ') : t, late: logged ? logged.late === '1' : diffDays(s.date, builtAt) > 4 });
  }
  const summary = summarize(dates, px, items, rule, { chainBad, future, mismatches });
  return { summary, newRows };
}


// 由簽名清單計每期回報同統計（forwardLog 同 evaluateLogged 共用）
function summarize(dates, px, items, rule, extra) {
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
  return {
    rule, settled: done.length, periods,
    meanExcess: r4(m), sdExcess: r4(sd),
    t: sd ? Math.round(100 * m / sd * Math.sqrt(ex.length)) / 100 : null,
    // 6 年回測每期超額 +1.16%、sd 約 5.45% → |t|=2 需約 89 期；以現時 forward 平均／sd 推算只作參考
    // 平均超額 ≤ 0 → 唔計（inconclusive），免得負值畀出睇落合理嘅期數
    needed: m > 0 && sd ? Math.ceil((2 * sd / m) ** 2) : null,
    inconclusive: m !== null && m <= 0,
    ...extra, lateCount: items.filter((x) => x.late).length,
  };
}

export function appendLog(file, newRows) {
  if (!newRows.length) return;
  fs.mkdirSync(file.replace(/[/\\][^/\\]*$/, ''), { recursive: true });
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const exists = cur.trim().length > 0;
  const body = toCsv(LOG_COLS, newRows);
  // 檔尾冇換行就先補一個，否則新行會黏落最後一行
  fs.appendFileSync(file, (exists && !cur.endsWith('\n') ? '\n' : '') + (exists ? body.split('\n').slice(1).join('\n') : body));
  writeAnchor(file, readLog(file));
}

// ---- anchors.json：每個 log 檔嘅 {count, tail}。hash 鏈驗唔到「尾部被刪」同「merge conflict 靜靜跌行」，anchor 補呢個洞。
// 同樣靠 git history 做最終錨點；作用係令無聲刪行／改尾變成即時報錯。每次 appendLog 自動更新。
export const anchorFile = (file) => file.replace(/[^/\\]*$/, '') + 'anchors.json';
export const anchorOf = (rows) => ({ count: rows.length, tail: rows.at(-1)?.hash || '' });
export function readAnchors(file) {
  const f = anchorFile(file);
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; }
}
export function writeAnchor(file, rows) {
  const a = readAnchors(file);
  a[file.split(/[/\\]/).pop()] = anchorOf(rows);
  fs.writeFileSync(anchorFile(file), JSON.stringify(a, null, 1) + '\n');
}
// 返回 null（正常）或問題描述。多咗行（未更新 anchor）唔當錯誤，因為 anchor 只喺 appendLog 時推進。
export function checkAnchor(rows, anchor) {
  if (!anchor) return rows.length ? '未有 anchor（未登記）' : null;
  if (rows.length < anchor.count) return `少咗 ${anchor.count - rows.length} 行（anchor ${anchor.count}，實際 ${rows.length}）`;
  if (anchor.count && rows[anchor.count - 1].hash !== anchor.tail) return `第 ${anchor.count} 行 hash 同 anchor 唔一致（紀錄被改或重排）`;
  return null;
}
