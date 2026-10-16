// sync.mjs — 4 份報告 → 瘦身 CSV（append-only、按月分片、唔 copy 原始檔）
// 用法：node scripts/sync.mjs [--days=90] [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, toCsv } from './lib/csv.mjs';
import * as S from './lib/sources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const DAYS = Number(args.days || 120);
const DRY = !!args.dry;

const COLS = {
  hk:       ['date','ticker','close','sharpe','cagr','vol','mdd','week','month','beta','var95'],
  us:       ['date','ticker','close','sharpe','cagr','vol','mdd','week','month','beta','var95'],
  sentinel: ['date','ticker','name','market','sector','close','sharpe','vol','mdd','week','month','action','risk','risk_text'],
  pmfx:     ['date','ticker','name','action','votes','opp','close','entry','target','stop','rr','rrv','net_rr','net_rrv','ev','net_ev','atr','stop_pct','rank','source','sharpe','err'],
  macro:    ['date','vix','dxy','us10y','cu_au','fng','n_symbols','n_buy','n_sell','n_hold','avg_sharpe','winrate'],
};
const FILES = {
  hk: (m) => path.join(DATA, 'hk', `${m}.csv`),
  us: (m) => path.join(DATA, 'us', `${m}.csv`),
  sentinel: (m) => path.join(DATA, 'sentinel', `${m}.csv`),
  pmfx: (m) => path.join(DATA, 'pmfx', `${m}.csv`),
  macro: (m) => path.join(DATA, 'macro', `${m}.csv`),
};

function loadShards(family) {
  const dir = path.dirname(FILES[family]('2000-01'));
  const present = new Map();               // date → true
  if (!fs.existsSync(dir)) return present;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.csv'))) {
    const rows = parseCsv(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const r of rows) if (r.date) present.set(r.date, true);
  }
  return present;
}
function appendRows(family, rows) {
  const byMonth = new Map();
  for (const r of rows) {
    const m = S.monthOf(r.date);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(r);
  }
  const stats = [];
  for (const [m, rs] of byMonth) {
    const file = FILES[family](m);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const existing = fs.existsSync(file) ? parseCsv(fs.readFileSync(file, 'utf8')) : [];
    const have = new Set(existing.map((r) => r.date + '|' + r.ticker));
    const fresh = rs.filter((r) => !have.has(r.date + '|' + r.ticker));
    if (!fresh.length) { stats.push([m, 0]); continue; }
    const merged = [...existing, ...fresh].sort((a, b) =>
      (a.date + a.ticker).localeCompare(b.date + b.ticker));
    if (!DRY) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, toCsv(COLS[family], merged));
    }
    stats.push([m, fresh.length]);
  }
  return stats;
}

const report = [];
function doFamily(family, dateMap, rowFn, label) {
  const dates = S.listDates(dateMap, DAYS);
  const present = loadShards(family);
  const todo = dates.filter((d) => !present.has(d));
  const rows = [];
  for (const d of todo) {
    try { rows.push(...rowFn(dateMap.get(d), d)); }
    catch (e) { console.error(`  ⚠️  ${label} ${d}: ${e.message}`); }
  }
  const stats = rows.length ? appendRows(family, rows) : [];
  report.push([label, dates.length, todo.length, rows.length, stats]);
  console.log(`${label}: 來源 ${dates.length} 日, 新 ${todo.length} 日, ${rows.length} 行${DRY ? ' (dry)' : ''}`);
}

console.log(`=== sync（最近 ${DAYS} 日）===`);
doFamily('hk', S.quantDates('hk'), (f, d) => S.quantRows('hk', f, d), 'HK quant');
doFamily('us', S.quantDates('us'), (f, d) => S.quantRows('us', f, d), 'US quant');
doFamily('sentinel', S.sentinelDates(), (f, d) => S.sentinelRows(f, d), 'Sentinel');
doFamily('pmfx', S.pmfxDates(), (f, d) => S.pmfxRows(f, d), 'PMFX');
// 宏觀：逐日抽 summary.md
{
  const rows = [], present = loadShards('macro');
  for (const d of S.listDates(new Map(S.sentinelDates()), DAYS)) {
    if (present.has(d)) continue;
    const m = S.sentinelMacro(d);
    if (m) rows.push(m);
  }
  const stats = rows.length ? appendRows('macro', rows) : [];
  report.push(['Macro', rows.length, 0, rows.length, stats]);
  console.log(`Macro: ${rows.length} 行${DRY ? ' (dry)' : ''}`);
}

// 體積報告（防止再次爆倉）
console.log('\n=== repo 資料體積 ===');
let total = 0;
for (const fam of Object.keys(COLS)) {
  const dir = path.dirname(FILES[fam]('2000-01'));
  let sz = 0, files = 0;
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) {
    sz += fs.statSync(path.join(dir, f)).size; files++;
  }
  total += sz;
  console.log(`  ${fam.padEnd(9)} ${files} 個分片  ${(sz / 1024).toFixed(1)} KB`);
}
console.log(`  總計 ${(total / 1048576).toFixed(2)} MB`);
const BUDGET = 20 * 1048576;
if (total > BUDGET) {
  console.error(`\n❌ 超出體積預算 20 MB（現 ${(total / 1048576).toFixed(2)} MB）→ 停止，請先 rollup`);
  process.exit(2);
}
