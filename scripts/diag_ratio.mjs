// diag_ratio.mjs — 只讀診斷：repo close 對 prices/raw_closes 檔嘅比例喺重疊日係咪穩定？
//   node scripts/diag_ratio.mjs --prices results/raw_closes_us_<日>.csv [--market us]
// 試三種日期對齊（檔案日期 +0 / 向前 1 個交易日 / 向後 1 個交易日），睇邊種比例最穩（spread ≤ 0.3% 嘅股票數最多）。
import fs from 'node:fs';
import { parseCsv, num } from './lib/csv.mjs';
import { loadAll } from './engine.mjs';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const wide = parseCsv(fs.readFileSync(arg('--prices'), 'utf8'));
const rows = loadAll()[arg('--market', 'us')];
const dcol = Object.keys(wide[0])[0];
const dates = wide.map((r) => String(r[dcol]).slice(0, 10));
const repo = new Map();
for (const r of rows) { const c = num(r.close); if (c > 0) (repo.get(r.ticker) || repo.set(r.ticker, new Map()).get(r.ticker)).set(r.date, c); }
const spread = (a) => (a.length < 5 ? null : Math.max(...a) / Math.min(...a) - 1);
for (const shift of [0, -1, 1]) {
  const sp = [], ex = [];
  for (const t of repo.keys()) {
    if (!(t in wide[0])) continue;
    const rs = [];
    wide.forEach((w, i) => { const j = i + shift; const rd = dates[i], fv = j >= 0 && j < wide.length ? num(wide[j][t]) : 0; const rv = repo.get(t).get(rd); if (rv > 0 && fv > 0) rs.push(rv / fv); });
    const s = spread(rs); if (s !== null) { sp.push(s); if (ex.length < 3) ex.push(`${t}: ${rs.slice(0, 6).map((x) => x.toFixed(4)).join(' ')} … 最後 ${rs.at(-1).toFixed(4)}`); }
  }
  sp.sort((a, b) => a - b);
  console.log(`對齊 ${shift >= 0 ? '+' : ''}${shift}：${sp.length} 隻，spread ≤0.3% 有 ${sp.filter((x) => x <= 0.003).length}，中位數 ${(100 * sp[sp.length >> 1]).toFixed(2)}%`);
  ex.forEach((e) => console.log('   ' + e));
}
