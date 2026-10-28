// make_corrections.mjs — 搵出「上游整日抓舊價」嘅 HK/US 行，生成 data/backfill/corrections.csv（只更正 close，原始 CSV 不動）
//   node scripts/make_corrections.mjs --prices results/raw_closes_hk_<日>.csv          # dry-run
//   node scripts/make_corrections.mjs --prices ... --apply                              # 寫入（只新增，已有嘅 date|ticker 唔重複）
// 判斷（全部要成立）：repo 值同下載檔同日差 >0.3%，而且 repo 值等於下載檔相鄰交易日收市（±0.3%）；
// 而且同一日有 ≥50% 股票係咁（整日報告抓錯一日）。零星個別點（例如單隻除息）唔會被當成整日錯誤。
// 更正值 = 下載檔嗰日真實收市（唔插補、唔重算）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, toCsv, num } from './lib/csv.mjs';
import { loadAll } from './engine.mjs';
import { planBackfill, LIMITS } from './backfill_prices.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CORR_FILE = path.join(ROOT, 'data', 'backfill', 'corrections.csv');
const COLS = ['date', 'ticker', 'close', 'source', 'reason'];
const shift = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);

// 純計算：wide + repo 行（要係未更正嘅原始行）→ { lag, rows, days }
export function planCorrections(wide, repoRows, source = 'prices', opts = {}) {
  const lag = opts.lag ?? planBackfill(wide, repoRows, [], source).lag;
  const dcol = Object.keys(wide[0] || {})[0];
  const tol = LIMITS.ratioTol, minShare = opts.minShare ?? 0.5;
  const byDate = new Map();                                    // repo 日期 → { total, bad: [] }
  const idx = new Map(wide.map((w, i) => [shift(String(w[dcol]).slice(0, 10), lag), i]));
  for (const r of repoRows) {
    const rv = num(r.close), i = idx.get(r.date);
    if (!(rv > 0) || i === undefined) continue;
    const fv = num(wide[i][r.ticker]);
    if (!(fv > 0)) continue;
    const e = byDate.get(r.date) || byDate.set(r.date, { total: 0, bad: [] }).get(r.date);
    e.total++;
    if (Math.abs(rv / fv - 1) <= tol) continue;
    const near = [i - 1, i + 1].some((j) => j >= 0 && j < wide.length && num(wide[j][r.ticker]) > 0 && Math.abs(rv / num(wide[j][r.ticker]) - 1) <= tol);
    if (near) e.bad.push({ date: r.date, ticker: r.ticker, close: String(fv), source, reason: '上游抓舊價：repo 值 = 相鄰交易日收市' });
  }
  const days = [...byDate].filter(([, e]) => e.total >= 10 && e.bad.length / e.total >= minShare).map(([d, e]) => ({ date: d, bad: e.bad.length, total: e.total })).sort((a, b) => (a.date < b.date ? -1 : 1));
  const ok = new Set(days.map((d) => d.date));
  const rows = [...byDate.values()].flatMap((e) => e.bad).filter((r) => ok.has(r.date));
  return { lag, rows, days };
}

if (process.argv[1] && process.argv[1].endsWith('make_corrections.mjs')) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const f = arg('--prices');
  if (!f) { console.error('用法: node scripts/make_corrections.mjs --prices <raw_closes_*.csv> [--apply]'); process.exit(2); }
  const wide = parseCsv(fs.readFileSync(f, 'utf8'));
  const tick = new Set(Object.keys(wide[0]).slice(1));
  // 用未更正嘅原始行：loadAll 已套用現有 corrections，close_raw 先係原值
  const fam = loadAll();
  const raw = [...fam.hk, ...fam.us].filter((r) => tick.has(r.ticker)).map((r) => (r.close_raw !== undefined ? { ...r, close: r.close_raw } : r));
  const plan = planCorrections(wide, raw, path.basename(f));
  console.log(`日期對齊 lag=${plan.lag}；整日抓舊價嘅日子 ${plan.days.length} 日：` + (plan.days.map((d) => `${d.date}（${d.bad}/${d.total}）`).join('、') || '—'));
  const cur = fs.existsSync(CORR_FILE) ? parseCsv(fs.readFileSync(CORR_FILE, 'utf8')) : [];
  const have = new Set(cur.map((r) => r.date + '|' + r.ticker));
  const add = plan.rows.filter((r) => !have.has(r.date + '|' + r.ticker));
  console.log(`更正 ${plan.rows.length} 行，其中新增 ${add.length} 行`);
  for (const r of add.slice(0, 5)) console.log(`  ${r.date} ${r.ticker} → ${r.close}`);
  if (!process.argv.includes('--apply')) { console.log('dry-run，冇寫檔。加 --apply 先寫入。'); process.exit(0); }
  fs.mkdirSync(path.dirname(CORR_FILE), { recursive: true });
  fs.writeFileSync(CORR_FILE, toCsv(COLS, [...cur, ...add]));
  console.log('已寫 ' + path.relative(ROOT, CORR_FILE));
}
