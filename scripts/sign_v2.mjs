// sign_v2.mjs — 本機簽 hk-lowmdd-252-v1 影子紀錄（trailing 252 日 MDD，頭 10 隻）
//   node scripts/sign_v2.mjs --prices /mnt/d/project-files/prices/prices_2026-10-16.csv          # dry-run
//   node scripts/sign_v2.mjs --prices ... --apply                                                # 寫 data/forward/hk-lowmdd-252.csv
// 簽名日同 v1 完全一樣（2026-10-16 起每 28 日曆日）。每次簽完會接駁上一行 hash，所以只可以順序追加。
// 之後開 PR（唔好直接 push main）；簽唔到嘅日期（prices 缺當日）會列出原因。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from './lib/csv.mjs';
import { loadAll } from './engine.mjs';
import { RULE_V2, readLog, signWindowed, appendLog } from './forward.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const V2_FILE = path.join(ROOT, 'data', 'forward', 'hk-lowmdd-252.csv');

if (process.argv[1] && process.argv[1].endsWith('sign_v2.mjs')) {
  const i = process.argv.indexOf('--prices');
  const f = i > 0 ? process.argv[i + 1] : null;
  if (!f) { console.error('用法: node scripts/sign_v2.mjs --prices <prices_*.csv> [--apply]'); process.exit(2); }
  const fam = loadAll();
  const { newRows, skipped } = signWindowed(parseCsv(fs.readFileSync(f, 'utf8')), fam.hk, readLog(V2_FILE));
  for (const r of newRows) console.log(`簽 ${r.signal_date} ${r.rule}${r.late === '1' ? '（late）' : ''}: ${r.tickers}`);
  for (const s of skipped) console.log(`跳過 ${s.date}: ${s.reason}`);
  if (!newRows.length) console.log('冇新嘅簽名。');
  else if (!process.argv.includes('--apply')) console.log('dry-run，冇寫檔。加 --apply 先寫入。');
  else { appendLog(V2_FILE, newRows); console.log('已寫 ' + path.relative(ROOT, V2_FILE)); }
}
