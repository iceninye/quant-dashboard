// backfill_prices.mjs — 用本機 prices_<日>.csv（寬表：首欄日期、其餘欄 = ticker）補 repo 缺口期嘅收市價
//   node scripts/backfill_prices.mjs --prices /mnt/d/project-files/prices/prices_2026-10-16.csv          # dry-run
//   node scripts/backfill_prices.mjs --prices ... --apply                                                # 寫 data/backfill/closes.csv
// 只補「repo 內該 ticker 該日冇有效收市價」嘅日子，範圍限於 repo 現有日期區間；已有嘅 repo 數據永遠優先，唔覆蓋。
// 補嘅只係收市價（畀前向回報用），唔係 mdd / sharpe 等訊號欄，所以唔會令缺口期出現新訊號。
// prices 檔係「整份按快照日復權」，repo 係「每日未復權收市」，所以同一隻股票兩邊差一個比例（股息 / 拆股累積）。
// 逐隻股票用缺口前後最近嘅重疊日計比例 r = repo / prices：
//   前後比例一致（差 ≤ 0.3%）→ 缺口內冇股息 / 拆股，將 prices 乘 r 換成 repo 基準，先補；
//   前後比例唔一致（缺口內有除息或拆股）或缺任何一邊重疊 → 呢隻呢日唔補。
// 整體要有 ≥ 60% 有缺口嘅股票能補，同 ≥ 30 個重疊點，否則拒絕。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, toCsv, num } from './lib/csv.mjs';
import { loadAll } from './engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BACKFILL_FILE = path.join(ROOT, 'data', 'backfill', 'closes.csv');
const COLS = ['date', 'ticker', 'close', 'source', 'scale'];
export const LIMITS = { ratioTol: 0.003, minOverlap: 30, minAccepted: 0.6 };

export function readBackfill(file = BACKFILL_FILE) {
  return fs.existsSync(file) ? parseCsv(fs.readFileSync(file, 'utf8')) : [];
}

// 純計算：wide（parseCsv 結果）+ repo 行 + 現有 backfill → { add, overlap, perTicker, rejected, range }
export function planBackfill(wide, repoRows, existing = [], source = 'prices') {
  const repo = new Map();                 // ticker → Map(date → close)
  let first = '9999', last = '';
  for (const r of repoRows) {
    if (r.date < first) first = r.date;
    if (r.date > last) last = r.date;
    const c = num(r.close);
    if (c > 0) (repo.get(r.ticker) || repo.set(r.ticker, new Map()).get(r.ticker)).set(r.date, c);
  }
  const dcol = Object.keys(wide[0] || {})[0];
  const file = new Map();                 // ticker → Map(date → close)
  for (const row of wide) {
    const date = String(row[dcol]).slice(0, 10);
    if (date < first || date > last) continue;
    for (const [k, v] of Object.entries(row)) {
      const c = k === dcol ? null : num(v);
      if (c > 0) (file.get(k) || file.set(k, new Map()).get(k)).set(date, c);
    }
  }
  const done = new Set(existing.map((r) => r.ticker + '|' + r.date));
  const add = [], perTicker = [];
  let overlapN = 0;
  for (const [t, fm] of file) {
    const rm = repo.get(t);
    if (!rm) continue;
    const ov = [...fm.keys()].filter((d) => rm.has(d)).sort();           // 重疊日（升序）
    overlapN += ov.length;
    const todo = [...fm.keys()].filter((d) => !rm.has(d) && !done.has(t + '|' + d)).sort();
    if (!todo.length) continue;
    let ok = 0, skipped = 0;
    for (const d of todo) {
      const b = ov.filter((x) => x < d).at(-1), a = ov.find((x) => x > d);
      if (!b || !a) { skipped++; continue; }
      const rb = rm.get(b) / fm.get(b), ra = rm.get(a) / fm.get(a);
      if (Math.abs(rb / ra - 1) > LIMITS.ratioTol) { skipped++; continue; }
      const scale = (rb + ra) / 2;
      add.push({ date: d, ticker: t, close: (fm.get(d) * scale).toFixed(4), source, scale: scale.toFixed(6) });
      ok++;
    }
    perTicker.push({ ticker: t, ok, skipped });
  }
  const withGap = perTicker.length, accepted = perTicker.filter((x) => x.ok > 0).length;
  const rejected = overlapN < LIMITS.minOverlap ? '重疊日少於 30 個，無法核對'
    : withGap && accepted / withGap < LIMITS.minAccepted ? `只有 ${accepted}/${withGap} 隻股票前後比例一致，低於 ${100 * LIMITS.minAccepted}%`
    : null;
  return { add, overlap: { n: overlapN }, perTicker, accepted, withGap, rejected, range: [first, last] };
}

if (process.argv[1] && process.argv[1].endsWith('backfill_prices.mjs')) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const f = arg('--prices');
  if (!f) { console.error('用法: node scripts/backfill_prices.mjs --prices <prices_*.csv> [--apply] [--force]'); process.exit(2); }
  const fam = loadAll();
  const plan = planBackfill(parseCsv(fs.readFileSync(f, 'utf8')), [...fam.hk, ...fam.us], readBackfill(), path.basename(f));
  const dates = [...new Set(plan.add.map((r) => r.date))].sort();
  console.log(`repo 區間 ${plan.range.join(' → ')} | 重疊 ${plan.overlap.n} 點 | 有缺口嘅股票 ${plan.withGap}，可補 ${plan.accepted}`);
  console.log(`可補 ${plan.add.length} 行 / ${dates.length} 日（${dates[0] || '—'} → ${dates.at(-1) || '—'}）；跳過（缺口內有除息 / 拆股，或缺前後重疊）${plan.perTicker.reduce((a, x) => a + x.skipped, 0)} 點`);
  if (plan.rejected && !process.argv.includes('--force')) { console.error('拒絕：' + plan.rejected); process.exit(1); }
  if (!process.argv.includes('--apply')) { console.log('dry-run，冇寫檔。加 --apply 先寫入。'); process.exit(0); }
  fs.mkdirSync(path.dirname(BACKFILL_FILE), { recursive: true });
  const cur = fs.existsSync(BACKFILL_FILE) ? fs.readFileSync(BACKFILL_FILE, 'utf8') : '';
  const body = toCsv(COLS, plan.add);
  fs.appendFileSync(BACKFILL_FILE, cur.trim() ? (cur.endsWith('\n') ? '' : '\n') + body.split('\n').slice(1).join('\n') : body);
  console.log('已寫 ' + path.relative(ROOT, BACKFILL_FILE));
}
