// check.mjs — smoke test（唔靠外部報告檔，只驗邏輯 + 已 sync 嘅數據）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, toCsv } from './lib/csv.mjs';
import * as E from './engine.mjs';
import * as S from './lib/sources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓ ' + m)) : (fail++, console.error('  ✗ ' + m)); };

console.log('CSV');
const rows = [{ a: '1,2', b: 'say "hi"' }, { a: '', b: 'x\ny' }];
const rt = parseCsv(toCsv(['a', 'b'], rows));
ok(rt[0].a === '1,2', 'quote/comma round-trip');
ok(rt[1].b === 'x\ny', 'newline in field round-trip');
ok(parseCsv('\ufeffa,b\n1,2\n')[0].a === '1', 'BOM stripped');

console.log('日期');
ok(S.dmyToIso('17-10-2026') === '2026-10-17', 'dmyToIso');
ok(S.isoToDmy('2026-10-17') === '17-10-2026', 'isoToDmy');
ok(S.monthOf('2026-10-17') === '2026-10', 'monthOf');

console.log('Quality gate');
const base = { err: '0', rrv: '1', net_rrv: '1', stop_pct: '3.00', rr: '2', net_ev: '5' };
ok(E.quality(base).ok, '正常訊號過關');
ok(!E.quality({ ...base, stop_pct: '0.10' }).ok, '止損退化被拒（0.10%）');
ok(!E.quality({ ...base, rrv: '0' }).ok, 'rr_valid=false 被拒');
ok(!E.quality({ ...base, err: '1' }).ok, 'error 欄非空被拒');
ok(!E.quality({ ...base, net_ev: '-1' }).ok, '負 EV 被拒');
ok(!E.quality({ ...base, stop_pct: '15' }).ok, '止損過遠（15%）被拒');

console.log('方向判定');
ok(E.sideOf('買') === 1 && E.sideOf('沽') === -1 && E.sideOf('觀望') === 0, 'sideOf');
ok(E.sentiOf('可加倉') === 1 && E.sentiOf('強烈減持') === -1, 'sentiOf');

console.log('前向追蹤：限價要成交先計回報');
{
  const mk = (date, close) => ({ date, ticker: 'X', name: 'X', action: '沽', close: String(close), entry: '110', target: '90', stop: '115', net_ev: '1' });
  const days = Array.from({ length: 25 }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`);
  const never = E.forwardTrack({ pmfx: days.map((d) => mk(d, 100)) })[0];
  ok(never.outcome === 'unfilled' && never.r5 === null, '價從未升到 entry → unfilled、冇回報');
  const px = [100, 111, 105, 104, 103, 102, 101].concat(Array(18).fill(101));
  const hit = E.forwardTrack({ pmfx: days.map((d, i) => mk(d, px[i])) })[0];
  ok(hit.filled && hit.fillDay === 1, '第 1 日收市 ≥ entry → 成交');
  ok(Math.abs(hit.r5 - ((110 - 101) / 110 - E.CFG.costPct / 100)) < 1e-9, 'r5 由 entry 計、扣成本');
}

console.log('已 sync 數據');
let total = 0;
for (const fam of ['hk', 'us', 'sentinel', 'pmfx', 'macro']) {
  const dir = path.join(ROOT, 'data', fam);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.csv')) : [];
  let n = 0, sz = 0;
  for (const f of files) { sz += fs.statSync(path.join(dir, f)).size; n += parseCsv(fs.readFileSync(path.join(dir, f), 'utf8')).length; }
  total += sz;
  ok(n > 0, `${fam}: ${files.length} 分片 / ${n} 行 / ${(sz / 1024).toFixed(0)} KB`);
}
ok(total < E.CFG.budgetMB * 1048576, `總體積 ${(total / 1048576).toFixed(2)} MB < 預算 ${E.CFG.budgetMB} MB`);

console.log('引擎輸出');
const res = E.run();
ok(res.quality.total > 0, `PMFX 標的數 ${res.quality.total}`);
ok(Array.isArray(res.opportunities) && res.opportunities.length === res.quality.total, 'opportunities 數量一致');
ok(res.tracking.length > 0, `前向追蹤 ${res.tracking.length} 條`);
ok(res.series.length > 0, `序列 ${res.series.length} 日`);
ok(res.audit.ladder.length >= 5, 'gate 階梯');
ok(res.quality.clean === 0 || res.opportunities.some((o) => o.tier !== 'EXCLUDED'), '通過 gate 數一致');

console.log('\nHTML 輸出');
const idx = path.join(ROOT, 'docs', 'index.html');
ok(fs.existsSync(idx), 'docs/index.html 存在');
const h = fs.readFileSync(idx, 'utf8');
ok(!/https?:\/\//.test(h.replace(/https:\/\/iceninye[^"']*/g, '')), '冇外部 CDN 依賴');
ok(h.includes('免責'), '含免責聲明');

console.log(`\n${pass} 通過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
