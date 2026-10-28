// gap_sources.mjs — 只讀：喺本機搵 Dashboard 數據缺口嘅「原檔」（mirror / iCloud archive / Obsidian / 其他資料夾）
//   node scripts/gap_sources.mjs                         # 掃預設位置
//   node scripts/gap_sources.mjs --root "/mnt/c/Users/ice_n/Documents/Obsidian" --fam hk,us,sentinel
// 唔會改任何檔案。搵到嘅話，輸出 results/gap-sources-<時間>/restore_plan.sh（cp -n -p，只新增、零覆蓋），
// 睇清楚先自己跑；之後 node scripts/sync.mjs --days=150 → build → check。
// 搵唔到嘅缺口：確認後寫入 data/known_gaps.csv（fam,from,to,reason），Dashboard 就會由「未解決」移去「已知限制」。
// 只還原「當日上游真實產出嘅原檔」，唔會用任何方式重算／插補缺口日嘅數據。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SRC, isoToDmy } from './lib/sources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iso = (t) => new Date(t).toISOString().slice(0, 10);

// 缺口 (from, to) 之間（不含兩端）嘅每個日曆日
export function gapDates(from, to) {
  const out = [];
  for (let t = Date.parse(from) + 864e5; t < Date.parse(to); t += 864e5) out.push(iso(t));
  return out;
}

// 該 family 嗰日係咪預期有報告（用 cron 時間表；港股假期等睇唔到，所以搵唔到唔一定係問題）
export function expected(fam, date) {
  const dow = new Date(date + 'T00:00:00Z').getUTCDay();      // 0 = Sun
  if (fam === 'sentinel') return dow === 2 || dow === 5;      // Tue + Fri
  if (fam === 'us') return dow >= 2 && dow <= 6;              // Tue–Sat
  return dow >= 1 && dow <= 5;                                // hk / pmfx：Mon–Fri
}

// 睇檔案內容（唔靠路徑）判斷係邊個 family 嘅咩檔。head = 檔頭文字
export function classify(file, head) {
  const base = path.basename(file);
  const m = /^(metrics|signals|summary)_(\d{2}-\d{2}-\d{4})\.(csv|md)$/.exec(base);
  if (!m) return null;
  const [, kind, dmy] = m;
  if (kind === 'metrics') {
    const lines = head.split(/\r?\n/);
    const cols = (lines[0] || '').split(',');
    const ti = cols.indexOf('ticker');
    if (ti < 0 || !cols.includes('max_drawdown')) return null;
    const first = ((lines[1] || '').split(',')[ti] || '').trim();
    if (!first) return null;
    return { fam: first.endsWith('.HK') ? 'hk' : 'us', kind, dmy };
  }
  if (kind === 'signals') {
    const h = (head.split(/\r?\n/)[0] || '');
    if (h.includes('risk_level')) return { fam: 'sentinel', kind, dmy };
    if (h.includes('opportunity_score') || h.includes('vote_score')) return { fam: 'pmfx', kind, dmy };
    return null;
  }
  if (/VIX|Fear & Greed/.test(head)) return { fam: 'sentinel', kind, dmy };
  if (/MC Paths|Risk-Free Rate/.test(head)) return { fam: /quant-us|research us|[\\/]us[\\/]/i.test(file) ? 'us' : 'hk', kind, dmy };
  return null;
}

export function targetOf(c, base) {
  if (c.fam === 'hk' || c.fam === 'us') return c.kind === 'metrics' ? path.join(SRC[c.fam], 'data', base) : path.join(SRC[c.fam], base);
  if (c.fam === 'sentinel') return path.join(SRC.sentinel, c.dmy, base);
  return path.join(SRC.pmfx, c.dmy, 'data', base);          // pmfx signals
}

const readHead = (f, n = 4096) => { const fd = fs.openSync(f, 'r'); try { const b = Buffer.alloc(n); const k = fs.readSync(fd, b, 0, n, 0); return b.toString('utf8', 0, k); } finally { fs.closeSync(fd); } };

// 喺 roots 入面搵所有叫呢啲名嘅檔（find，唔 follow symlink 迴圈；權限錯誤忽略）
export function findFiles(roots, names) {
  const hits = new Set();
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    const args = [r, '-type', 'f', '-size', '+0', '(', ...names.flatMap((n, i) => (i ? ['-o', '-name', n] : ['-name', n])), ')'];
    let out = '';
    try { out = execFileSync('find', args, { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch (e) { out = e.stdout || ''; }
    for (const l of out.split('\n')) if (l) hits.add(l);
  }
  return [...hits].sort();
}

// 核心：wanted = [{ fam, date }]，回傳 { found: [{fam,date,kind,src,target,size}], skipped }
export function locate(roots, wanted) {
  const want = new Map();                                   // `${fam}|${dmy}` → date
  const names = new Set();
  for (const w of wanted) {
    const d = isoToDmy(w.date);
    want.set(w.fam + '|' + d, w.date);
    for (const k of ['metrics', 'signals', 'summary']) names.add(`${k}_${d}.${k === 'summary' ? 'md' : 'csv'}`);
  }
  const found = [], seen = new Set();
  for (const f of findFiles(roots, [...names])) {
    let head = '';
    try { head = readHead(f); } catch { continue; }
    const c = classify(f, head);
    if (!c) continue;
    const date = want.get(c.fam + '|' + c.dmy);
    if (!date) continue;
    const target = targetOf(c, path.basename(f));
    if (fs.existsSync(target) && fs.statSync(target).size > 0) continue;   // 上游已有，唔使還原
    const key = target;
    if (seen.has(key)) continue;                            // 同一目標多個來源：取第一個，其餘列出
    seen.add(key);
    found.push({ fam: c.fam, date, kind: c.kind, src: f, target, size: fs.statSync(f).size });
  }
  return found;
}

if (process.argv[1] && process.argv[1].endsWith('gap_sources.mjs')) {
  const E = await import('./engine.mjs');
  const args = process.argv.slice(2);
  const all = (k) => args.flatMap((a, i) => (a === k ? [args[i + 1]] : []));
  const fams = (all('--fam')[0] || 'hk,us,sentinel').split(',');
  const HOME = os.homedir();
  const roots = [path.join(HOME, 'hermes-projects'), path.join(HOME, 'hermes reports'), SRC.icloud, ...all('--root')];
  const cov = E.dataAudit(E.loadAll()).coverage;
  const known = E.loadKnownGaps();
  const lines = [], plan = ['#!/usr/bin/env bash', '# 只新增、零覆蓋（cp -n）。睇清楚每行先跑。', 'set -euo pipefail'];
  const wanted = [], gaps = [];
  for (const c of cov) {
    const fam = c.fam === 'macro' ? 'sentinel' : c.fam;          // macro 由 Sentinel summary 抽
    if (!fams.includes(fam)) continue;
    for (const g of c.gaps) {
      if (known.some((k) => k.fam === c.fam && k.from === g.from && k.to === g.to)) continue;
      if (c.fam === 'macro') continue;                            // 同 sentinel 缺口一齊處理
      const ds = gapDates(g.from, g.to).filter((d) => expected(fam, d));
      gaps.push({ fam, from: g.from, to: g.to, ds });
      for (const d of ds) wanted.push({ fam, date: d });
    }
  }
  console.log(`搜尋位置：\n${roots.map((r) => `  ${fs.existsSync(r) ? '✓' : '✗ 唔存在'} ${r}`).join('\n')}`);
  const found = locate(roots, wanted);
  const out = path.join(ROOT, 'results', 'gap-sources-' + new Date().toISOString().replace(/[:T]/g, '').slice(0, 13));
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'found.tsv'), 'fam\tdate\tkind\tsize\tsrc\ttarget\n' + found.map((f) => [f.fam, f.date, f.kind, f.size, f.src, f.target].join('\t')).join('\n') + '\n');
  const nothing = [];
  for (const g of gaps) {
    const got = found.filter((f) => f.fam === g.fam && f.date > g.from && f.date < g.to);
    const days = new Set(got.filter((f) => f.kind !== 'summary').map((f) => f.date));
    console.log(`${g.fam} ${g.from} → ${g.to}：預期有報告 ${g.ds.length} 日，搵到原檔 ${days.size} 日${days.size ? '（' + [...days].sort().join('、') + '）' : ''}`);
    if (!days.size) nothing.push(g);
  }
  for (const f of found) plan.push(`mkdir -p "${path.dirname(f.target)}" && cp -n -p "${f.src}" "${f.target}"   # ${f.fam} ${f.date} ${f.kind}`);
  fs.writeFileSync(path.join(out, 'restore_plan.sh'), plan.join('\n') + '\n', { mode: 0o755 });
  console.log(`\n共 ${found.length} 個可還原檔案 → ${path.relative(ROOT, out)}/restore_plan.sh（未執行）`);
  if (found.length) console.log('確認後：bash ' + path.relative(ROOT, path.join(out, 'restore_plan.sh')) + ' && node scripts/sync.mjs --days=150 && node scripts/build.mjs && node scripts/check.mjs');
  if (nothing.length) {
    console.log('\n完全搵唔到原檔嘅缺口（確認冇其他位置之後，可加入 data/known_gaps.csv；唔好未確認就加）：');
    for (const g of nothing) for (const fam of g.fam === 'sentinel' ? ['sentinel', 'macro'] : [g.fam])
      console.log(`  ${fam},${g.from},${g.to},本機 mirror／iCloud archive／其他位置搵唔到原檔（上游當日冇產出）`);
  }
}
