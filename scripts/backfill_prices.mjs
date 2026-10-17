// backfill_prices.mjs — 用本機 prices_<日>.csv（寬表：首欄日期、其餘欄 = ticker）補 repo 缺口期嘅收市價
//   node scripts/backfill_prices.mjs --prices /mnt/d/project-files/prices/prices_2026-10-16.csv          # dry-run
//   node scripts/backfill_prices.mjs --prices ... --apply                                                # 寫 data/backfill/closes.csv
// 只補「repo 內該 ticker 該日冇有效收市價」嘅日子，範圍限於 repo 現有日期區間；已有嘅 repo 數據永遠優先，唔覆蓋。
// 補嘅只係收市價（畀前向回報用），唔係 mdd / sharpe 等訊號欄，所以唔會令缺口期出現新訊號。
// 先用重疊日比對：同 repo 收市價偏差太大（復權口徑唔同）就拒絕。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, toCsv, num } from './lib/csv.mjs';
import { loadAll } from './engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BACKFILL_FILE = path.join(ROOT, 'data', 'backfill', 'closes.csv');
const COLS = ['date', 'ticker', 'close', 'source'];
export const LIMITS = { medianAbs: 0.002, p95Abs: 0.01 };

export function readBackfill(file = BACKFILL_FILE) {
  return fs.existsSync(file) ? parseCsv(fs.readFileSync(file, 'utf8')) : [];
}

// 純計算：wide（parseCsv 結果）+ repo 行 + 現有 backfill → { add, overlap, rejected }
export function planBackfill(wide, repoRows, existing = [], source = 'prices') {
  const have = new Map();                 // ticker|date → repo 收市價
  let first = '9999', last = '';
  for (const r of repoRows) {
    if (r.date < first) first = r.date;
    if (r.date > last) last = r.date;
    const c = num(r.close);
    if (c > 0) have.set(r.ticker + '|' + r.date, c);
  }
  const done = new Set(existing.map((r) => r.ticker + '|' + r.date));
  const dcol = Object.keys(wide[0] || {})[0];
  const diffs = [], add = [];
  for (const row of wide) {
    const date = String(row[dcol]).slice(0, 10);
    if (date < first || date > last) continue;
    for (const [k, v] of Object.entries(row)) {
      if (k === dcol) continue;
      const c = num(v);
      if (!(c > 0)) continue;
      const key = k + '|' + date, r = have.get(key);
      if (r) diffs.push(Math.abs(c / r - 1));
      else if (!done.has(key)) add.push({ date, ticker: k, close: String(c), source });
    }
  }
  diffs.sort((a, b) => a - b);
  const q = (p) => (diffs.length ? diffs[Math.min(diffs.length - 1, Math.floor(p * diffs.length))] : null);
  const overlap = { n: diffs.length, medianAbs: q(0.5), p95Abs: q(0.95), max: diffs.at(-1) ?? null };
  const rejected = overlap.n < 30 ? '重疊日少於 30 個，無法核對復權口徑'
    : overlap.medianAbs > LIMITS.medianAbs || overlap.p95Abs > LIMITS.p95Abs ? `重疊日偏差過大（median ${(100 * overlap.medianAbs).toFixed(3)}%、p95 ${(100 * overlap.p95Abs).toFixed(3)}%）`
    : null;
  return { add, overlap, rejected, range: [first, last] };
}

if (process.argv[1] && process.argv[1].endsWith('backfill_prices.mjs')) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const f = arg('--prices');
  if (!f) { console.error('用法: node scripts/backfill_prices.mjs --prices <prices_*.csv> [--apply] [--force]'); process.exit(2); }
  const fam = loadAll();
  const plan = planBackfill(parseCsv(fs.readFileSync(f, 'utf8')), [...fam.hk, ...fam.us], readBackfill(), path.basename(f));
  const dates = [...new Set(plan.add.map((r) => r.date))].sort();
  console.log(`repo 區間 ${plan.range.join(' → ')} | 重疊 ${plan.overlap.n} 點 median ${plan.overlap.medianAbs === null ? '—' : (100 * plan.overlap.medianAbs).toFixed(4) + '%'} p95 ${plan.overlap.p95Abs === null ? '—' : (100 * plan.overlap.p95Abs).toFixed(4) + '%'}`);
  console.log(`可補 ${plan.add.length} 行 / ${dates.length} 日（${dates[0] || '—'} → ${dates.at(-1) || '—'}）`);
  if (plan.rejected && !process.argv.includes('--force')) { console.error('拒絕：' + plan.rejected); process.exit(1); }
  if (!process.argv.includes('--apply')) { console.log('dry-run，冇寫檔。加 --apply 先寫入。'); process.exit(0); }
  fs.mkdirSync(path.dirname(BACKFILL_FILE), { recursive: true });
  const cur = fs.existsSync(BACKFILL_FILE) ? fs.readFileSync(BACKFILL_FILE, 'utf8') : '';
  const body = toCsv(COLS, plan.add);
  fs.appendFileSync(BACKFILL_FILE, cur.trim() ? (cur.endsWith('\n') ? '' : '\n') + body.split('\n').slice(1).join('\n') : body);
  console.log('已寫 ' + path.relative(ROOT, BACKFILL_FILE));
}
