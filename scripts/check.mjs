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

console.log('Holm / t 分佈');
const FX = await import('./factors.mjs');
ok(Math.abs(2 * FX.tPValue(2, 10) - 0.0734) < 0.0005, 't=2,df=10 雙尾 p ≈ 0.0734');
ok(Math.abs(FX.tPValue(0, 5) - 0.5) < 1e-9, 't=0 單尾 p = 0.5');
ok(JSON.stringify(FX.holm([0.01, 0.04, 0.03, null])) === JSON.stringify([0.03, 0.06, 0.06, null]), 'Holm step-down 單調 + 跳過 null');

console.log('Forward log');
const FW = await import('./forward.mjs');
{
  // 合成 HK：40 隻，每日 +0.1% 漂移；A00 回撤最淺（mdd 最高）
  const rule = { ...FW.RULE, liveFrom: '2026-01-05', top: 5, stepDays: 28, costBps: 30, minNames: 30 };
  const start = Date.parse('2026-01-05'), rows = [];
  for (let d = 0; d < 80; d++) {
    const dt = new Date(start + d * 86400000);
    if ([0, 6].includes(dt.getUTCDay())) continue;
    const date = dt.toISOString().slice(0, 10);
    for (let i = 0; i < 40; i++) rows.push({ date, ticker: 'T' + String(i).padStart(2, '0'), close: String(100 * (1 + (i < 5 ? 0.002 : 0.001)) ** d), mdd: String(-0.01 * (i + 1)) });
  }
  const a = FW.forwardLog(rows, [], '2026-04-01', rule);
  ok(a.newRows.length === a.summary.periods.length && a.newRows.length >= 3, `簽名期數 ${a.newRows.length}`);
  ok(a.newRows[0].tickers === 'T00 T01 T02 T03 T04', '揀 mdd 最高頭 5 隻');
  const p0 = a.summary.periods[0];
  ok(p0.entry > p0.signalDate, '入場日喺簽名日之後（t+1）');
  ok(p0.status === 'settled' && p0.cost === 0.003, '第一期換手 100% → 成本 30 bps');
  ok(a.summary.periods[1].cost === 0, '組合不變 → 成本 0');
  ok(p0.excess > 0 && p0.names === 5, '低 MDD 組漂移較高 → 超額為正');
  ok(a.summary.periods.at(-1).status !== 'settled', '最後一期未結算');
  const again = FW.forwardLog(rows, a.newRows, '2026-04-01', rule);
  ok(again.newRows.length === 0 && again.summary.mismatches.length === 0, '重跑冪等，唔重複寫');
  const tampered = a.newRows.map((r, i) => (i ? r : { ...r, tickers: 'T39 T38 T37 T36 T35' }));
  const tm = FW.forwardLog(rows, tampered, '2026-04-01', rule).summary;
  ok(tm.mismatches.length === 1 && tm.mismatches[0].kind === 'log-edited' && tm.chainBad.length >= 1, '改 tickers：紀錄被改 + 斷鏈');
  ok(FW.verifyChain(a.newRows).length === 0, '鏈完整');
  ok(FW.verifyChain(a.newRows.map((r, i) => (i === 1 ? { ...r, built_at: '2020-01-01' } : r))).length >= 1, '改 built_at 斷鏈');
  ok(FW.verifyChain(a.newRows.filter((_, i) => i !== 1)).length >= 1, '刪一行斷鏈');
  const fut = [...a.newRows, { signal_date: '2030-01-01', rule: rule.version, tickers: 'X', mdd_hash: 'x', built_at: '2026-04-01', late: '0', prev_hash: a.newRows.at(-1).hash, hash: 'bad' }];
  const fs2 = FW.forwardLog(rows, fut, '2026-04-01', rule).summary;
  ok(fs2.future.includes('2030-01-01') && fs2.chainBad.includes('2030-01-01'), '未來日期行被偵測');
  const restated = rows.map((r) => (r.ticker === 'T00' && r.date === a.newRows[0].signal_date ? { ...r, mdd: '-0.5' } : r));
  const rs = FW.forwardLog(restated, a.newRows, '2026-04-01', rule).summary;
  ok(rs.mismatches[0]?.kind === 'restated' || rs.mismatches[0]?.kind === 'input-restated', '上游 restate 同篡改分開標示');
  const v2 = { ...rule, version: 'v2-test' };
  const both = [...a.newRows];
  const b2 = FW.forwardLog(rows, both, '2026-04-01', v2);
  ok(b2.newRows.length === a.newRows.length && b2.summary.mismatches.length === 0, '不同 rule version 同日並存，互不干擾');
  ok(b2.newRows[0].prev_hash === a.newRows.at(-1).hash, 'v2 接駁喺 v1 鏈尾');
  { const f = path.join(ROOT, 'scripts', '.tmp-fwd.csv'); fs.writeFileSync(f, FW.LOG_COLS.join(',') + '\n' + 'x,x,x,x,x,x,x,x'); FW.appendLog(f, a.newRows.slice(0, 1)); const L = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); fs.unlinkSync(f); ok(L.length === 3, 'appendLog 檔尾冇換行唔黏行'); }
  ok(FW.forwardLog(rows, [], '2026-04-20', rule).newRows[0].late === '1', '遲 build 標 late');
  const cut = rows.filter((r) => r.date < '2026-01-26' || r.date > '2026-02-13');
  ok(FW.signalDates([...new Set(cut.map((r) => r.date))].sort(), rule).length < FW.signalDates([...new Set(rows.map((r) => r.date))].sort(), rule).length, '簽名日缺數據 > 4 日 → 跳過');
}
console.log('Backfill / 拆股');
const BF = await import('./backfill_prices.mjs');
const F2 = await import('./factors.mjs');
{
  const dts = []; for (let i = 0; i < 60; i++) dts.push(new Date(Date.parse('2026-06-01') + i * 86400000).toISOString().slice(0, 10));
  const px = (i, d) => 100 + i + d * 0.5;
  const repo = [], wide = [];
  dts.forEach((d, di) => {
    const w = { date: d };
    for (let i = 0; i < 40; i++) { w['T' + i] = String(px(i, di) * 1.07); if (di < 20 || di > 29) repo.push({ date: d, ticker: 'T' + i, close: String(px(i, di)) }); }   // prices 檔整體高 7%（復權基準唔同）
    wide.push(w);
  });
  const plan = BF.planBackfill(wide, repo, []);
  ok(!plan.rejected && plan.add.length === 40 * 10, `補缺口期 ${plan.add.length} 行（10 日 × 40 隻）`);
  ok(plan.add.every((r) => Math.abs(Number(r.close) / px(Number(r.ticker.slice(1)), dts.indexOf(r.date)) - 1) < 1e-4), '按比例換成 repo 基準（不是直接抄 prices 數值）');
  ok(plan.add.every((r) => r.date >= dts[20] && r.date <= dts[29]), '只補缺口日');
  ok(BF.planBackfill(wide, repo, plan.add).add.length === 0, '重跑冪等');
  // 缺口內除息：缺口之後比例變 5% → 該股票唔補
  const div = wide.map((w, di) => (di > 29 ? { ...w, T0: String(Number(w.T0) * 1.05) } : w));
  const pd = BF.planBackfill(div, repo, []);
  ok(!pd.add.some((r) => r.ticker === 'T0') && pd.add.some((r) => r.ticker === 'T1'), '缺口內比例變（除息 / 拆股）→ 該股票唔補，其他照補');
  const allBad = wide.map((w, di) => (di > 29 ? Object.fromEntries(Object.entries(w).map(([k, v]) => [k, k === 'date' ? v : String(Number(v) * 1.05)])) : w));
  ok(/比例一致/.test(BF.planBackfill(allBad, repo, []).rejected || ''), '大部分股票比例唔一致 → 整體拒絕');
  ok(/少於 30/.test(BF.planBackfill(wide, repo.slice(0, 5), []).rejected || ''), '重疊太少無法核對 → 拒絕');
  const sNo = F2.priceSeries(repo), sBf = F2.priceSeries([...repo, ...plan.add]);
  ok(F2.fwdReturn(sNo.get('T1'), dts[18], 5) === null && F2.fwdReturn(sBf.get('T1'), dts[18], 5) !== null, '缺口期補價後，跨缺口窗口由「唔計」變「可計」');
  // 拆股
  const ev = [];
  const sp = F2.priceSeries([100, 102, 104, 52, 52.5, 53].map((c, i) => ({ date: '2026-09-0' + (i + 1), ticker: 'S', close: String(c) })), ev);
  ok(ev.length === 1 && ev[0].k === 2 && Math.abs(sp.get('S').px[0] - 50) < 1e-9 && Math.abs(sp.get('S').px[5] - 53) < 1e-9, '2:1 拆股：之前價格除 2，之後不變');
  const crash = F2.priceSeries([100, 102, 104, 60, 61].map((c, i) => ({ date: '2026-09-0' + (i + 1), ticker: 'C', close: String(c) })), []);
  ok(crash.get('C').px[0] === 100, '單日 −42%（唔係整數比例）唔當拆股');
}

console.log('Forward v2（trailing 252 影子紀錄）');
{
  const rule = { ...FW.RULE_V2, liveFrom: '2026-01-05', top: 5, window: 12, minNames: 30 };
  const start = Date.parse('2026-01-05'), hk = [], dts = [];
  for (let d = 0; d < 80; d++) {
    const dt = new Date(start + d * 86400000);
    if ([0, 6].includes(dt.getUTCDay())) continue;
    dts.push(dt.toISOString().slice(0, 10));
  }
  const wide = [];
  dts.forEach((date, di) => {
    const w = { date: date + ' 00:00:00' };
    for (let i = 0; i < 40; i++) {
      const t = 'T' + String(i).padStart(2, '0') + '.HK';
      // i 越細回撤越淺：每隔幾日跌 i% 再回升
      const p = 100 * (1 + 0.001 * di) * (1 - (di % 7 === 3 ? 0.002 * i : 0));
      w[t] = String(p);
      hk.push({ date, ticker: t, close: String(p), mdd: '' });
    }
    wide.push(w);
  });
  const a = FW.signWindowed(wide, hk, [], '2026-04-01', rule);
  ok(a.newRows.length >= 2 && a.newRows[0].tickers.startsWith('T00.HK'), `簽 ${a.newRows.length} 期，最淺回撤 T00 排頭`);
  ok(FW.verifyChain(a.newRows).length === 0 && a.newRows[0].rule === rule.version, 'v2 hash 鏈完整');
  ok(FW.signWindowed(wide, hk, a.newRows, '2026-04-01', rule).newRows.length === 0, '重簽冪等');
  const scaled = wide.map((w) => Object.fromEntries(Object.entries(w).map(([k, v]) => [k, k === 'date' ? v : String(Number(v) * 0.93)])));
  ok(FW.signWindowed(scaled, hk, [], '2026-04-01', rule).newRows.map((r) => r.tickers).join('|') === a.newRows.map((r) => r.tickers).join('|'), '整份歷史乘常數（之後除息復權）名單不變');
  const short = FW.signWindowed(wide.slice(-10), hk, [], '2026-04-01', rule);
  ok(short.newRows.length === 0 && short.skipped.length >= 1, 'prices 唔夠日數 → 跳過並講原因');
  const ev = FW.evaluateLogged(hk, a.newRows, rule);
  ok(ev.periods.length === a.newRows.length && ev.unverifiable && ev.chainBad.length === 0, '評估已簽名單（唔重算）');
  ok(FW.evaluateLogged(hk, a.newRows.map((r, i) => (i ? r : { ...r, tickers: 'X.HK' })), rule).chainBad.length >= 1, '改名單斷鏈');
}

console.log('Anchor');
{
  const rows = [{ hash: 'a' }, { hash: 'b' }, { hash: 'c' }];
  const an = FW.anchorOf(rows);
  ok(FW.checkAnchor(rows, an) === null, 'anchor 一致');
  ok(/少咗 1 行/.test(FW.checkAnchor(rows.slice(0, 2), an)), '尾部被刪偵測到（hash 鏈驗唔到）');
  ok(/唔一致/.test(FW.checkAnchor([{ hash: 'a' }, { hash: 'b' }, { hash: 'x' }], an)), '改尾偵測到');
  ok(FW.checkAnchor([...rows, { hash: 'd' }], an) === null, '多咗行（未更新 anchor）唔當錯');
  ok(FW.checkAnchor([], null) === null && /未登記/.test(FW.checkAnchor(rows, null)), '未登記 anchor 嘅非空 log 要報');
  const f = path.join(ROOT, 'scripts', '.tmp-anchor', 'x.csv');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  FW.appendLog(f, [{ signal_date: 'd', rule: 'r', tickers: 't', mdd_hash: 'm', built_at: 'b', late: '0', prev_hash: '', hash: 'h1' }]);
  FW.appendLog(f, [{ signal_date: 'e', rule: 'r', tickers: 't', mdd_hash: 'm', built_at: 'b', late: '0', prev_hash: 'h1', hash: 'h2' }]);
  const a2 = FW.readAnchors(f)['x.csv'];
  fs.rmSync(path.dirname(f), { recursive: true, force: true });
  ok(a2.count === 2 && a2.tail === 'h2', 'appendLog 自動推進 anchor');
  for (const [file, name] of [['hk-lowmdd.csv', 'v1'], ['hk-lowmdd-252.csv', 'v2']]) {
    const lf = path.join(ROOT, 'data', 'forward', file);
    if (!fs.existsSync(lf)) continue;
    ok(FW.checkAnchor(FW.readLog(lf), FW.readAnchors(lf)[file]) === null, `repo ${name} 紀錄同 anchors.json 一致`);
  }
}

console.log('引擎輸出');
const res = E.run();
ok(res.quality.total > 0, `PMFX 標的數 ${res.quality.total}`);
ok(Array.isArray(res.opportunities) && res.opportunities.length === res.quality.total, 'opportunities 數量一致');
ok(res.tracking.length > 0, `前向追蹤 ${res.tracking.length} 條`);
ok(res.series.length > 0, `序列 ${res.series.length} 日`);
ok(res.forward && res.forward.rule.version && res.pmfxNew.needed === 20, 'forward / pmfxNew 欄位');
ok(res.factors.flatMap((f) => f.byH).every((h) => h.windows >= 8 || h.grade === 'fail'), '窗口少於 8 個一律唔評級');
ok(res.factors.flatMap((f) => f.byH).every((h) => h.grade !== 'pass' || h.adjP < 0.05), '通過級一定 Holm 校正後 p < 0.05');
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
