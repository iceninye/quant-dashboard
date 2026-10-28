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

// --list：用比例最穩嘅對齊，列出偏離 >0.3% 嘅點，按日期分組；並睇 repo 值係咪等於檔案相鄰交易日（= repo 抓到舊價／錯日）
if (process.argv.includes('--list')) {
  const best = [0, 1].map((lag) => {
    let n = 0; for (const t of repo.keys()) { if (!(t in wide[0])) continue; const rs = []; wide.forEach((w, i) => { const d = shiftD(dates[i], lag), rv = repo.get(t).get(d), fv = num(w[t]); if (rv > 0 && fv > 0) rs.push(rv / fv); }); if (rs.length >= 5 && Math.max(...rs) / Math.min(...rs) - 1 <= 0.003) n++; } return { lag, n };
  }).sort((a, b) => b.n - a.n || a.lag - b.lag)[0].lag;
  function shiftD(d, n) { return new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10); }
  const by = new Map(); let total = 0, stale = 0, other = 0;
  for (const t of repo.keys()) {
    if (!(t in wide[0])) continue;
    wide.forEach((w, i) => {
      const fv = num(w[t]), rd = shiftD(dates[i], best), rv = repo.get(t).get(rd);
      if (!(rv > 0 && fv > 0) || Math.abs(rv / fv - 1) <= 0.003) return;
      total++;
      const near = [i - 1, i + 1].some((j) => j >= 0 && j < wide.length && Math.abs(rv / num(wide[j][t]) - 1) <= 0.003);
      near ? stale++ : other++;
      (by.get(rd) || by.set(rd, []).get(rd)).push(`${t} ${(100 * (rv / fv - 1)).toFixed(2)}%`);
    });
  }
  console.log(`\n--list（lag=${best}）：偏離 >0.3% 共 ${total} 點；其中 repo 值等於相鄰交易日收市（抓舊價／錯日）${stale}，其他 ${other}`);
  for (const [d, a] of [...by].sort()) console.log(`  ${d}  ${a.length} 隻  例：${a.slice(0, 3).join('，')}`);
}
