// build.mjs — 生成 docs/index.html（單檔、零 CDN、讀 ./data/dashboard.json）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const J = path.join(DOCS, 'data', 'dashboard.json');

// 確保 JSON 新鮮：直接跑 engine（唔靠 cron）
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'engine.mjs')], { stdio: 'inherit' });
const D = JSON.parse(fs.readFileSync(J, 'utf8'));

const fmt = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(d));
const pct = (v, d = 2) => (v === null || v === undefined ? '—' : (v * 100).toFixed(d) + '%');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const FT = 2;  // 同 factors.mjs FCFG.tPass
const PN = D.pmfxNew, FW = D.forward, V2 = D.forwardV2;
const V2pair = (() => {
  if (!V2) return { n: 0 };
  const m = new Map(V2.periods.filter((p) => p.excess !== undefined).map((p) => [p.signalDate, p.excess]));
  const d = FW.periods.filter((p) => p.excess !== undefined && m.has(p.signalDate)).map((p) => p.excess - m.get(p.signalDate));
  return { n: d.length, diff: d.length ? d.reduce((a, b) => a + b, 0) / d.length : null };
})();
const pmOpen = PN.settled >= PN.needed;
const EV = D.evidence;
const evHero = `<p style="font-size:17px;margin:0 0 8px"><b class="${EV.verified.length ? 'good' : 'bad'}">${EV.verified.length} 個已驗證機會</b>${EV.verified.length ? '：' + EV.verified.map((v) => esc(v.label)).join('、') : ''}；${EV.inForward.length} 個前向測試進行中${EV.inForward.length ? '（' + EV.inForward.map((f) => `<code>${esc(f.rule)}</code> 第 ${f.period} 期，已結算 ${f.settled}/${f.need}`).join('、') + '）' : ''}。</p>
<p class="dim" style="font-size:13px;margin:0 0 8px">已驗證 = 歷史檢驗通過 <b>且</b> 前向確認（因子：事前凍結紀錄結算 ≥ ${EV.rule.fwdSettled} 期、t ≥ ${EV.rule.fwdT}、鏈完整；PMFX：修正後結算 ≥ ${EV.rule.pmfxSettled} 個、平均 R > 0）。任何一樣未有 = 唔係機會。</p>`;
const pass = D.factors.filter((f) => f.grade === 'pass' && f.market !== 'sentinel');
const watch = D.factors.filter((f) => f.grade === 'watch' && f.market !== 'sentinel');
const bestW = watch.length ? watch[0].byH.filter((h) => h.grade === 'watch').sort((a, b) => b.t - a.t)[0] : null;
const sen = D.factors.find((f) => f.market === 'sentinel');
const pmFilled = D.tracking.filter((t) => t.filled).length;
// 本機長樣本多因子掃描（analysis/make_scan_json.py 產出；冇檔就唔顯示）
const SJ = path.join(DOCS, 'data', 'scan.json');
const SC = fs.existsSync(SJ) ? JSON.parse(fs.readFileSync(SJ, 'utf8')) : null;
const scanMk = { hk: '港股', us: '美股' };
const scanStrong = (m) => SC.samples.filter((s) => s.market === m).some((s) => s.counts?.pass > 0)
  || SC.samples.filter((s) => s.market === m && (s.counts?.watch || 0) > 0).length >= 2;
const gcls = (g) => ({ PASS: 'gpass', WATCH: 'gwatch' }[g] || 'gfail');
const scanHtml = !SC ? '' : `<h2 id="s2b"><span class="n">2b</span>長樣本多因子掃描（本機跑，${esc(SC.run || '')}）</h2>
<div class="card scroll"><table><thead><tr><th>樣本</th><th>數據</th><th>檢定</th><th>PASS</th><th>WATCH</th><th>最好檢定</th><th>每期超額</th><th>t</th><th>Holm p</th><th>正年份</th><th>跟最好因子（最長持有期）</th></tr></thead><tbody>
${SC.samples.map((s) => { const b = s.top[0] || {}; const m = s.meta[s.meta.length - 1];
  return `<tr><td>${scanMk[s.market] || esc(s.market)} ${esc(s.label)}</td><td class="dim">${esc(s.start)} → ${esc(s.asof)} · ${s.tickers} 隻</td>
<td>${s.counts?.tests ?? '—'}</td><td class="${s.counts?.pass ? 'gpass' : 'dim'}">${s.counts?.pass ?? '—'}</td><td>${s.counts?.watch ?? '—'}</td>
<td>${esc(b.signal || '—')} @${b.H ?? '—'} 日 <span class="${gcls(b.grade)}">${esc(b.grade || '')}</span></td>
<td class="${(b.excess || 0) > 0 ? 'good' : 'bad'}">${fmt(b.excess)}%</td><td>${fmt(b.t)}</td><td class="dim">${fmt(b.holm, 3)}</td><td class="dim">${esc(b.years_pos || '—')}</td>
<td class="dim">${m ? `${m.H} 日 t ${fmt(m.t)}，每期 ${fmt(m.excess)}%` : '—'}</td></tr>`; }).join('')}
</tbody></table></div>
${Object.entries(SC.consensus).map(([m, list]) => scanStrong(m) && list.length ? `<div class="card"><b>${scanMk[m] || esc(m)}共識名單</b> <span class="dim">— PASS／WATCH 因子今日頭 10 名入面出現次數（同一類防守股，唔係已證實 edge）</span>
<div class="scroll"><table><thead><tr><th>標的</th><th>出現</th><th></th></tr></thead><tbody>
${list.map((x) => `<tr><td class="tk">${esc(x.ticker)}</td><td>${x.count}/${x.of}</td><td style="text-align:left"><span class="bar"><i style="width:${Math.round(x.count / x.of * 100)}%"></i></span></td></tr>`).join('')}
</tbody></table></div></div>` : `<p class="dim">${scanMk[m] || esc(m)}：冇足夠一致嘅因子（最多只得單一樣本 WATCH），唔列名單。</p>`).join('')}
<p class="note">方法：17 個價格因子 × 5 / 21 / 63 日持有，t+1 入場、按換手扣成本，同全 universe 等權比；全部檢定一齊 Holm 校正，另計 Deflated Sharpe、前後半段、逐年同牛熊分拆。「跟最好因子」= 每期只用已完結數據揀當時最好嘅因子，係計埋揀因子運氣嘅誠實數字。
<b>限制：</b>universe 係今日 most-active 名單（metrics 名單最早只到 2026-05，冇股票跌出過），倖存者偏差減唔到，絕對回報偏高；數字嚟自本機輸出，冇喺 cloud 獨立重跑。更新：本機跑 <code>analysis/run_local_validation.sh</code> → <code>python3 analysis/make_scan_json.py</code> → <code>publish.sh</code>。</p>`;
// 短線（1–5 日）：shortterm.mjs 產出
const ST = D.shortTerm;
const stAvoid = (ST?.avoid || []).map((x) => `${esc(x.marketLabel)}「${esc(x.label)}」持 ${x.H} 日（每期 ${pct(x.excess)}，t ${fmt(x.t)}）`);
const stHero = !ST ? '' : `<li>短線 1–5 日（§1b）：${ST.counts.tests} 個檢定，<b class="${ST.counts.pass ? 'gpass' : 'bad'}">${ST.counts.pass} 個通過</b>、${ST.counts.watch} 個觀察${ST.counts.pass ? '' : ' → <b>今日冇短線機會</b>'}。${stAvoid.length ? `顯著蝕錢：${stAvoid.slice(0, 2).join('、')}，<b class="bad">唔好追</b>。` : ''}</li>`;
const stHtml = !ST ? '' : `<h2 id="s1b"><span class="n">1b</span>短線機會（持有 1–5 日）</h2>
<div class="card"><p style="font-size:16px;margin:0 0 6px">${ST.counts.pass
  ? `<b class="gpass">${ST.counts.pass} 個短線訊號歷史檢驗通過</b>（前向未確認，未入 §1 已驗證名單）`
  : `<b class="bad">今日冇短線訊號通過驗證。</b>${ST.counts.watch ? `最接近係 ${ST.counts.watch} 個觀察級，名單只供參考，<b>唔係買入訊號</b>。` : ''}`}</p>
${stAvoid.length ? `<p class="bad" style="margin:0 0 6px">避開：${stAvoid.join('；')} — 扣成本後顯著跑輸等權（Bonferroni 校正單尾 p < 0.05）。</p>` : ''}
<p class="dim" style="margin:0">數據日：港股 ${ST.dates.hk || '—'} · 美股 ${ST.dates.us || '—'}（收市後更新，唔係盤中即時價）</p></div>
${ST.today.map((p) => `<div class="card"><div><b class="g${p.grade}">${p.grade === 'pass' ? '歷史通過（前向未確認）' : '觀察'}</b> · ${esc(p.marketLabel)} ${esc(p.label)} 頭 20% · ${p.date} 收市 ·
<span class="dim">持 ${p.H} 日每期超額 ${pct(p.excess)}，t ${fmt(p.t)}，Holm p ${fmt(p.adjP, 2)}</span></div>
<div class="scroll"><table><thead><tr><th>標的</th><th>收市</th><th>1 日</th><th>5 日</th><th>波動</th><th>MDD</th></tr></thead><tbody>
${p.names.map((x) => `<tr><td class="tk">${esc(x.ticker)}</td><td>${fmt(x.close)}</td><td class="${(x.r1 || 0) >= 0 ? 'good' : 'bad'}">${pct(x.r1, 1)}</td>
<td class="${(x.r5 || 0) >= 0 ? 'good' : 'bad'}">${pct(x.r5, 1)}</td><td>${pct(x.vol, 1)}</td><td>${pct(x.mdd, 1)}</td></tr>`).join('')}
</tbody></table></div></div>`).join('')}
<details class="card"><summary>全部 ${ST.counts.tests} 個短線檢定</summary><div class="scroll"><table><thead><tr><th>訊號</th><th>市場</th><th>持有</th><th>頭 20%</th><th>等權</th><th>超額</th><th>前半</th><th>後半</th><th>贏等權</th><th>窗口</th><th>t</th><th>Holm p</th><th>結果</th></tr></thead><tbody>
${ST.tests.map((h) => `<tr><td>${esc(h.label)}</td><td class="dim">${esc(h.marketLabel)}</td><td>${h.H} 日</td>
<td>${pct(h.top)}</td><td class="dim">${pct(h.ew)}</td><td class="${h.excess > 0 ? 'good' : 'bad'}">${pct(h.excess)}</td>
<td>${pct(h.isExcess)}</td><td>${pct(h.oosExcess)}</td><td>${h.beatRate}%</td><td>${h.windows}</td><td>${fmt(h.t)}</td><td class="dim">${h.adjP === null ? '—' : fmt(h.adjP, 2)}</td>
<td class="g${h.grade}">${{ pass: '通過', watch: '觀察', fail: '未通過' }[h.grade]}</td></tr>`).join('')}
</tbody></table></div>
<p class="note">方法：t 日收市計訊號，t+1 收市入場，持有 ${ST.cfg.horizons.join(' / ')} 個交易日，每個窗口扣 ${ST.cfg.costPct}% 來回成本（當全換手計，偏保守）；每日揀頭 20% 同當日等權比。前後半切 IS / OOS，非重疊窗口計 t；${ST.m} 個短線檢定一齊做 Holm。
<b>通過</b> = 前後半都正 + t ≥ ${ST.cfg.tPass} + Holm 單尾 p < ${ST.cfg.alpha} + 窗口 ≥ ${ST.cfg.minWindows}。
<b>限制：</b>只有日收市價，冇 OHLC／盤中數據，日內策略測唔到；樣本只有 repo 幾個月、universe 係每日報告名單（有倖存者偏差）。長樣本 5 日結果見 §2b。</p></details>`;
const scanHero = !SC ? '' : (() => { const hk = SC.samples.filter((s) => s.market === 'hk'); const p = hk.find((s) => s.counts?.pass);
  const lng = hk.find((s) => s.variant === 'union');
  return `<li>長樣本掃描（§2b）：${p ? `港股 ${esc(p.label)} 有 <b class="gpass">${p.counts.pass} 個 PASS</b>（${esc(p.top[0].signal)}）` : '港股冇 PASS'}${lng ? `，但 6 年樣本最好只係 <b class="${gcls(lng.top[0]?.grade)}">${esc(lng.top[0]?.grade || '—')}</b>` : ''} → 防守型大藍籌係最好選擇，但<b>未證實</b>；美股冇因子可信。</li>`; })();
const okOpp = D.opportunities.filter((o) => o.tier !== 'EXCLUDED');
const TIER = { VERIFIED: '已驗證', CAND: '候選（未驗證）', EXCLUDED: '剔除' };
const oppRow = (o) => `<tr><td class="tk">${esc(o.ticker)}<div class="dim" style="font-size:11.5px">${esc(o.name)}</div></td>
<td class="${o.action === '買' ? 'good' : o.action === '沽' ? 'bad' : 'dim'}">${esc(o.action)}</td>
<td>${fmt(o.close)}</td><td>${fmt(o.entry)}</td><td>${fmt(o.entryAtr, 1)}</td><td>${fmt(o.stopAtr)}</td><td>${fmt(o.geoRr)}</td>
<td>${o.pWin === null ? '—' : pct(o.pWin, 1)}<div class="dim" style="font-size:11px">打和 ${o.p0 === null ? '—' : pct(o.p0, 1)} · ${o.histK ?? 0}/${o.histN ?? 0}</div></td>
<td class="${(o.evR || 0) > 0 ? 'good' : 'bad'}">${fmt(o.evR)}R</td><td>${fmt(o.rank, 3)}</td>
<td class="dim">${fmt(o.cons)}</td><td class="t${o.tier}">${TIER[o.tier] || esc(o.tier)}</td></tr>`;
const oppHead = '<thead><tr><th>標的</th><th>方向</th><th>收市</th><th>限價 entry</th><th>入場/ATR</th><th>止損/ATR</th><th>RR</th><th>勝率下界</th><th>EV</th><th>rank</th><th>共識</th><th>狀態</th></tr></thead>';

const html = `<!DOCTYPE html>
<html lang="zh-Hant"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0b0f14">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Quant Board">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<link rel="icon" type="image/png" sizes="192x192" href="android-chrome-192x192.png">
<link rel="apple-touch-icon" sizes="180x180" href="apple-touch-icon.png">
<link rel="manifest" href="site.webmanifest">
<title>Quant Dashboard — 4 報告交叉驗證</title>
<style>
:root{--bg:#0b0f14;--panel:#121924;--panel2:#0f1620;--line:#1e2836;--tx:#dfe7f1;--dim:#8fa0b5;
--ok:#3ddc97;--warn:#ffcc66;--bad:#ff6b6b;--acc:#5ea9ff;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);
font:15px/1.55 system-ui,-apple-system,"Noto Sans TC",sans-serif;padding:18px 14px 60px;max-width:1240px;margin:auto}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:26px 0 8px;padding-bottom:6px;border-bottom:1px solid var(--line)}
h2 .n{color:var(--acc);font-family:var(--mono);margin-right:6px}
.sub{color:var(--dim);font-size:13px;margin-bottom:14px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:10px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.kv{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:9px 11px}
.kv b{display:block;font-family:var(--mono);font-size:19px;margin-top:2px}
.kv span{color:var(--dim);font-size:12px}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th,td{padding:6px 7px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
th:first-child,td:first-child{text-align:left}th{color:var(--dim);font-weight:600;font-size:12px;text-transform:uppercase}
td.tk{font-family:var(--mono)}tr:hover td{background:#151d29}
.tA{color:var(--ok);font-weight:700}.tB{color:var(--warn);font-weight:700}.tC{color:var(--acc)}
.tX{color:var(--bad);font-weight:700}.tVERIFIED{color:var(--ok);font-weight:700}.tCAND{color:var(--warn)}.tEXCLUDED{color:var(--dim)}
.bad{color:var(--bad)}.good{color:var(--ok)}.dim{color:var(--dim)}
.pill{display:inline-block;padding:1px 7px;border-radius:99px;font-size:11.5px;border:1px solid var(--line);font-family:var(--mono)}
p.note{background:#1a1206;border:1px solid #4a3a10;color:#ffd88a;border-radius:8px;padding:10px 12px;font-size:13.5px}
p.warn{background:#1d0f0f;border:1px solid #5a2020;color:#ffb3b3;border-radius:8px;padding:10px 12px;font-size:13.5px}
details{margin:6px 0}summary{cursor:pointer;color:var(--dim);font-size:13px}
.bar{height:8px;background:#1a2331;border-radius:4px;overflow:hidden;display:inline-block;width:90px;vertical-align:middle}
.bar i{display:block;height:100%;background:var(--acc)}
.spark{display:flex;gap:1px;align-items:flex-end;height:34px;margin-top:6px}
.spark i{flex:1;background:var(--acc);min-height:2px;border-radius:1px}
.spark i.e{background:var(--bad)}
footer{margin-top:26px;color:var(--dim);font-size:12.5px;border-top:1px solid var(--line);padding-top:12px}
code{font-family:var(--mono);background:#0d141d;padding:1px 5px;border-radius:4px;font-size:12.5px}
.hero{background:#0f1a14;border:1px solid #1f4a33;border-radius:12px;padding:14px 16px;margin:12px 0}
.hero h2{border:0;margin:0 0 8px;padding:0}.hero ul{margin:6px 0 0;padding-left:20px}.hero li{margin:4px 0}
.gpass{color:var(--ok);font-weight:700}.gwatch{color:var(--warn);font-weight:700}.gfail{color:var(--dim)}
div.warn{color:var(--warn)}.scroll{overflow-x:auto}nav{font-size:13px;color:var(--dim);margin:6px 0 4px}nav a{color:var(--acc);margin-right:12px;text-decoration:none}
</style></head><body>
<h1>Quant Dashboard <span class="dim" style="font-size:13px;font-weight:400">— 4 份報告交叉驗證</span></h1>
<div class="sub">生成 ${new Date(D.generatedAt).toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong' })} HKT ·
數據日：HK ${D.dates.hk || '—'} · US ${D.dates.us || '—'} · Sentinel ${D.dates.sen || '—'} · PMFX ${D.pmfxDate}</div>
<nav><a href="#s1">1 名單</a>${ST ? '<a href="#s1b">1b 短線</a>' : ''}<a href="#s2">2 因子驗證</a>${SC ? '<a href="#s2b">2b 長樣本</a>' : ''}<a href="#s3">3 前向紀錄</a><a href="#s4">4 PMFX 訊號</a><a href="#s5">5 PMFX 追蹤</a><a href="#s6">6 數據核對</a><a href="#s7">7 宏觀</a></nav>

<div class="hero"><h2>今日結論</h2>
${evHero}
${pass.length ? `<b class="gwatch">因子歷史檢驗通過（前向未確認，未算機會）：${pass.map((f) => esc(f.marketLabel + ' ' + f.label)).join('、')}</b>，名單見 §1。`
  : watch.length ? `<b>今日冇訊號通過驗證。</b>證據最強係 <b class="gwatch">${esc(watch[0].marketLabel + ' ' + watch[0].label)}</b>：
持有 ${bestW.H} 日，頭 20% 平均跑贏等權 <b>${pct(bestW.excess)}</b>（已扣成本；絕對回報 ${pct(bestW.top)} 對等權 ${pct(bestW.ew)}，即係「跌少啲」多過「賺錢」），前半段 ${pct(bestW.isExcess)}、後半段 ${pct(bestW.oosExcess)} 都係正，
但 t = ${fmt(bestW.t)}（單尾 p ${fmt(bestW.p, 3)}；同時測 ${bestW.m} 個檢定，Holm 校正後 p ${fmt(bestW.adjP, 2)}，要 < 0.05 先算通過）→ <b>只列觀察名單，唔係買入訊號</b>。`
  : '<b class="bad">今日冇任何訊號通過或接近驗證門檻。</b>'}
<ul>
<li>PMFX：限價成交嘅 ${pmFilled} 個歷史訊號，5 日平均 <b class="${(D.trackingStats.all.avgR5 || 0) > 0 ? 'good' : 'bad'}">${pct(D.trackingStats.all.avgR5)}</b>，到目標 ${D.trackingStats.all.wins} 個、止損 ${D.trackingStats.all.losses} 個；今日 ${D.quality.total} 張卡過幾何約束 ${D.quality.geoOk} 張、模型 EV > 0 ${D.quality.clean} 張 → <b>唔好跟</b>（§4–5）。</li>
${sen ? `<li>Sentinel「可加倉」對比「減持」：${sen.byH.map((h) => `${h.H} 日 ${pct(h.excess)}`).join('、')}（相對 29 隻等權）→ ${(sen.byH[0].excess || 0) < 0 ? '<b class="bad">跑輸，唔應該當加分</b>' : '有正面作用'}。</li>` : ''}
${stHero}
${scanHero}
<li>樣本只有 ${D.factors[0] ? D.factors[0].byH[0].days : '—'} 個有效交易日、一個市況，${D.dataAudit.issues.filter((i) => i.level === 'bad' || i.level === 'warn').length} 項未解決數據問題（另有 ${D.dataAudit.issues.filter((i) => i.level === 'limit').length} 項已知限制）見 §6。所有結論信心偏低。</li>
</ul></div>

<h2 id="s1"><span class="n">1</span>${EV.verified.length ? '已驗證機會名單' : '候選／觀察名單（未驗證）'}</h2>
${D.picks.length ? D.picks.map((p) => `<div class="card"><div><b class="g${p.grade}">${p.grade === 'pass' ? '歷史通過（前向未確認）' : '觀察'}</b> · ${esc(p.marketLabel)} ${esc(p.label)} 頭 20% · ${p.date} 收市 ·
<span class="dim">${p.best.H} 日超額 ${pct(p.best.excess)}，贏等權比率 ${p.best.beatRate}%</span></div>
<div class="scroll"><table><thead><tr><th>標的</th><th>收市</th><th>MDD</th><th>波動</th><th>Sharpe</th><th>月回報</th><th>Sentinel</th><th>PMFX</th></tr></thead><tbody>
${p.names.map((x) => `<tr><td class="tk">${esc(x.ticker)}</td><td>${fmt(x.close)}</td><td>${pct(x.mdd, 1)}</td><td>${pct(x.vol, 1)}</td>
<td>${fmt(x.sharpe)}</td><td class="${(x.month || 0) >= 0 ? 'good' : 'bad'}">${pct(x.month, 1)}</td>
<td class="dim">${esc(x.sentinel || '—')}</td><td class="dim">${esc(x.pmfx || '—')}</td></tr>`).join('')}
</tbody></table></div></div>`).join('') : '<p class="dim">冇因子達到觀察級（前後半段都正、t ≥ 1.5）。</p>'}

${stHtml}

<h2 id="s2"><span class="n">2</span>因子驗證 — 邊個訊號有前向回報</h2>
<div class="card scroll"><table><thead><tr><th>因子</th><th>市場</th><th>持有</th><th>頭 20%</th><th>等權</th><th>超額</th><th>前半</th><th>後半</th><th>贏等權</th><th>t</th><th>校正 p</th><th>結果</th></tr></thead><tbody>
${D.factors.map((f) => f.byH.map((h, i) => `<tr><td>${i ? '' : esc(f.label)}</td><td class="dim">${i ? '' : esc(f.marketLabel)}</td><td>${h.H} 日</td>
<td>${pct(h.top)}</td><td class="dim">${pct(h.ew)}</td><td class="${h.excess > 0 ? 'good' : 'bad'}">${pct(h.excess)}</td>
<td>${pct(h.isExcess)}</td><td>${pct(h.oosExcess)}</td><td>${h.beatRate}%</td><td>${fmt(h.t)}</td><td class="dim">${h.adjP === null ? '—' : fmt(h.adjP, 2)}</td>
<td class="g${h.grade}">${{ pass: '通過', watch: '觀察', fail: '未通過' }[h.grade]}</td></tr>`).join('')).join('')}
</tbody></table>
<p class="note">方法：訊號日之後第一個收市價入場，持有 5 / 20 個交易日，扣 ${D.cfg.costPct}% 來回成本；每日揀頭 20%（Sentinel 用「可加倉」對「減持」），同當日全體等權比。
樣本按日期切半做前半 / 後半。<b>通過</b> = 前後半都正 + 非重疊窗口 t ≥ ${FT} + <b>Holm 校正</b>（同時測 ${D.factors[0]?.byH[0].m ?? '—'} 個檢定，校正後單尾 p < 0.05）；<b>觀察</b> = 前後半都正但 t 只有 1.5–${FT}，或 t ≥ ${FT} 但校正後唔夠。持有期跨越數據缺口嘅窗口唔計。
非重疊窗口少於 ${D.cfg.minWindows ?? 8} 個（現時 20 日通常只有 1–3 個）一律唔評級，t 只作參考；校正 p 一欄「—」= 窗口太少，唔算入檢定數。</p></div>

${scanHtml}

<h2 id="s3"><span class="n">3</span>前向紀錄 — 港股低 MDD（事前凍結、事後照記）</h2>
<div class="card"><p>回測用「當日最活躍名單」有倖存者偏差，唯一無偏差嘅證據係<b>事前凍結規則、之後照記</b>。規則 <code>${esc(FW.rule.version)}</code>：
自 ${FW.rule.liveFrom} 起每 ${FW.rule.stepDays} 日曆日簽名一次，按 repo <code>mdd</code> 欄揀頭 ${FW.rule.top} 隻，下一個港股數據日收市入場，持有到下次入場，扣 ${FW.rule.costBps} bps × 換手，對比港股全體等權。
紀錄係 append-only 檔案 <code>data/forward/hk-lowmdd.csv</code>；規則改動要升 version，舊紀錄唔重寫。</p>
<div class="grid"><div class="kv"><span>已結算期數</span><b>${FW.settled}</b></div>
<div class="kv"><span>平均每期超額</span><b class="${(FW.meanExcess || 0) > 0 ? 'good' : 'bad'}">${pct(FW.meanExcess)}</b></div>
<div class="kv"><span>t</span><b>${fmt(FW.t)}</b></div>
<div class="kv"><span>補記（late）</span><b>${FW.lateCount}</b></div></div>
${FW.mismatches.length ? `<p class="warn">⚠ 紀錄同重算唔一致：${FW.mismatches.map((m) => `${m.date}（${{ 'log-edited': '輸入冇變但名單變 = 紀錄被改', restated: '名單同輸入都變 = 上游 restate 或兩邊被改', 'input-restated': '名單冇變但 mdd 值變咗 = 上游 restate' }[m.kind]}）`).join('、')}</p>` : ''}
${FW.chainBad.length || FW.future.length ? `<p class="warn">⚠ 紀錄鏈驗證失敗：${[...FW.chainBad, ...FW.future.map((d) => d + '（未來日期）')].join('、')}</p>` : ''}
${FW.anchorIssue ? `<p class="warn">⚠ v1 紀錄 anchor 檢查失敗：${esc(FW.anchorIssue)}</p>` : ''}
${FW.inconclusive ? '<p class="warn">平均超額 ≤ 0：所需期數唔計（INCONCLUSIVE）。</p>' : ''}
<div class="scroll"><table><thead><tr><th>簽名日</th><th>入場</th><th>出場</th><th>狀態</th><th>毛回報</th><th>成本</th><th>淨回報</th><th>等權</th><th>超額</th></tr></thead><tbody>
${FW.periods.slice().reverse().map((p) => `<tr><td>${p.signalDate}</td><td>${p.entry || '—'}</td><td>${p.exit || '—'}</td><td class="dim">${{ 'pending-entry': '等入場日', open: '持有中', settled: '已結算' }[p.status]}</td>
<td>${pct(p.gross)}</td><td class="dim">${pct(p.cost)}</td><td>${pct(p.net)}</td><td class="dim">${pct(p.bench)}</td><td class="${(p.excess || 0) > 0 ? 'good' : 'bad'}">${pct(p.excess)}</td></tr>`).join('')}
</tbody></table></div>
<div class="card" style="margin-top:10px"><b>影子紀錄 v2（trailing 252 日 MDD，<code>hk-lowmdd-252-v1</code>）</b>
${V2 ? `<div class="grid"><div class="kv"><span>已簽期數</span><b>${V2.periods.length}</b></div><div class="kv"><span>已結算</span><b>${V2.settled}</b></div>
<div class="kv"><span>平均每期超額</span><b class="${(V2.meanExcess || 0) > 0 ? 'good' : 'bad'}">${pct(V2.meanExcess)}</b></div>
<div class="kv"><span>v1 − v2（同期）</span><b>${V2pair.n ? pct(V2pair.diff) + '（' + V2pair.n + ' 期）' : '—'}</b></div></div>
${V2.anchorIssue ? `<p class="warn">⚠ v2 紀錄 anchor 檢查失敗：${esc(V2.anchorIssue)}</p>` : ''}
${V2.chainBad.length || V2.future.length ? `<p class="warn">⚠ v2 紀錄鏈驗證失敗：${[...V2.chainBad, ...V2.future].join('、')}</p>` : ''}
<p class="note">v2 名單係本機用 prices 檔簽名，repo 重算唔到，所以只驗鏈完整性，唔驗名單。影子紀錄，不入觀察 / 通過。</p>`
: '<p class="dim">未有簽名。由本機行 <code>node scripts/sign_v2.mjs --prices &lt;prices_*.csv&gt; --apply</code> 簽。</p>'}</div>
<p class="note">統計力：回測每期超額 sd 約 5%，要 |t| = 2 約需 89 期（≈ 7.4 年）。12 個月只有約 13 期，所以頭幾年只可以講「方向一致 / 唔一致」，<b>唔可以講驗證通過</b>。
注意：呢度用 repo 嘅 <code>mdd</code> 欄（約 2 年回撤），同 <code>docs/WFO.md</code> 用嘅 trailing W（63/126/252 日）係兩個唔同嘅訊號定義。</p></div>

<h2 id="s4"><span class="n">4</span>PMFX 今日訊號（未驗證）</h2>
<p class="warn">PMFX 自報勝率係 0.50 加分砌出嚟、同 RR 脫鈎，舊排序同股價水平相關，已停用。今日 ${D.quality.total} 張卡：過格式 ${D.quality.formatOk}、過幾何約束 ${D.quality.geoOk}、模型 EV > 0 ${D.quality.clean}。<b>冇一張係已驗證機會。</b></p>
<div class="card scroll"><table>${oppHead}<tbody>
${okOpp.length ? okOpp.map(oppRow).join('') : `<tr><td colspan="12" class="dim" style="text-align:left">今日冇卡過到幾何約束同模型 EV（呢個係預期結果，唔係 bug）。</td></tr>`}
</tbody></table>
<p class="note">幾何約束：入場離市價 ≤ ${D.cfg.maxEntryAtr}×ATR、止損 ≥ ${D.cfg.minStopAtr}×ATR、RR ${D.cfg.rrMin}–${D.cfg.rrMax}（全部由價格重算，唔用 PMFX 自報 rr）。
勝率 = 歷史前向追蹤同類卡（方向 × RR × 止損% × 入場/ATR 分層）嘅 target 比例，timeout 當輸，再向打和勝率 1/(1+RR) 收縮 ${D.cfg.priorN} 個虛擬樣本，取 Wilson 單尾 90% 下界；
EV = 勝率 × (RR + 1) − 1（R 單位），rank = (EV − 成本R) × 成交率。冇歷史樣本嘅類別勝率下界一定低過打和，即係 fail closed。</p>
<details><summary>剔除嘅 ${D.opportunities.length - okOpp.length} 個（排除原因）</summary><div class="scroll"><table>${oppHead}<tbody>
${D.opportunities.filter((o) => o.tier === 'EXCLUDED').map((o) => oppRow(o) + `<tr><td colspan="12" class="bad" style="text-align:left;font-size:12.5px">${esc(o.why.join(' / '))}</td></tr>`).join('')}
</tbody></table></div></details>
<div class="dim" style="font-size:12.5px">修正後（${PN.since} 起）乾淨訊號結算 ${PN.settled}/${PN.needed}${PN.avgR !== null ? `，平均 ${fmt(PN.avgR)}R` : ''}${PN.confirming ? '（前向確認）' : '（未夠，未確認）'}。</div></div>

<h2 id="s5"><span class="n">5</span>PMFX 前向追蹤 — 訊號之後實際發生咩事</h2>
<div class="card"><div class="grid">
<div class="kv"><span>追蹤訊號</span><b>${D.tracking.length}</b></div>
<div class="kv"><span>限價有成交</span><b>${pmFilled}</b></div>
<div class="kv"><span>20 日內冇成交</span><b class="dim">${D.tracking.filter((t) => t.outcome === 'unfilled').length}</b></div>
<div class="kv"><span>到目標 / 止損</span><b><span class="good">${D.trackingStats.all.wins}</span> / <span class="bad">${D.trackingStats.all.losses}</span></b></div>
<div class="kv"><span>平均 5 日（扣成本）</span><b class="${(D.trackingStats.all.avgR5 || 0) > 0 ? 'good' : 'bad'}">${pct(D.trackingStats.all.avgR5)}</b></div>
<div class="kv"><span>每筆實現 R 中位（已結算）</span><b class="${(D.trackingStats.all.medR || 0) > 0 ? 'good' : 'bad'}">${fmt(D.trackingStats.all.medR)}R</b></div>
</div>
<div class="scroll"><table style="margin-top:10px"><thead><tr><th>組別 / 累加 gate</th><th>訊號</th><th>已結算</th><th>勝率</th><th>平均 5 日</th><th>平均 20 日</th></tr></thead><tbody>
${[...D.audit.ladder.map((g) => [g.gate, g]), ['每日 net_ev 頭 1 名', D.audit.rankEdge.top1], ['每日 net_ev 尾 1 名', D.audit.rankEdge.bottom1],
  ['全部做多', D.audit.bySide.buy], ['全部做空', D.audit.bySide.sell]].map(([l, g]) => `<tr><td>${esc(l)}</td><td>${g.n}</td><td>${g.decided}</td>
<td class="${(g.winRate || 0) >= 50 ? 'good' : 'bad'}">${g.winRate === null ? '—' : g.winRate + '%'}</td><td>${pct(g.avgR5)}</td><td>${pct(g.avgR20)}</td></tr>`).join('')}
</tbody></table></div>
<p class="note">回報由限價 entry <b>成交之後</b>先計（收市價觸及 entry 先算成交，${D.cfg.fillDays} 個交易日內冇觸及 = 冇成交）。
出場用 stop-first：每日（包括成交當日）先查止損再查目標，止損用嗰日實際收市出場（跳空會蝕多過 1R）。repo 只有日收市，盤中觸及嘅止損漏計，所以結果仍然偏樂觀。加 gate 之後勝率或回報下跌 = gate 冇用。
2026-10-17 之前嘅 PMFX 行上游有 bug，新版仲未有結算樣本。</p>
<details><summary>最近 40 條訊號</summary><div class="scroll"><table><thead><tr><th>日期</th><th>標的</th><th>方向</th><th>結果</th><th>成交日</th><th>5日</th><th>20日</th></tr></thead><tbody>
${D.tracking.slice(-40).reverse().map((t) => `<tr><td>${t.date}</td><td class="tk">${esc(t.ticker)}</td>
<td class="${t.side > 0 ? 'good' : 'bad'}">${t.side > 0 ? '多' : '空'}</td>
<td class="${t.outcome === 'target' ? 'good' : t.outcome === 'stop' ? 'bad' : 'dim'}">${t.outcome}</td>
<td>${t.fillDay ?? '—'}</td><td>${pct(t.r5)}</td><td>${pct(t.r20)}</td></tr>`).join('')}
</tbody></table></div></details></div>

<h2 id="s6"><span class="n">6</span>數據核對</h2>
<div class="card">
${(() => {
  const row = (i) => `<div class="${i.level === 'info' || i.level === 'limit' ? 'dim' : i.level}" style="font-size:13.5px;margin:3px 0">${{ bad: '✘', warn: '⚠', limit: '⊘', info: '✓' }[i.level]} <b>${esc(i.fam)}</b>：${esc(i.msg)}</div>`;
  const lv = (...l) => D.dataAudit.issues.filter((i) => l.includes(i.level));
  const open = lv('bad', 'warn'), lim = lv('limit'), done = lv('info');
  return `<p><b>未解決 ${open.length} 項</b>（有補回或修復路徑，見各項說明）</p>${open.map(row).join('') || '<div class="dim" style="font-size:13.5px">冇</div>'}`
    + `<p style="margin-top:10px"><b>已知限制 ${lim.length} 項</b>（補唔到或補咗都用唔到；已寫明原因同對結論嘅影響，唔係被隱藏）</p>${lim.map(row).join('') || '<div class="dim" style="font-size:13.5px">冇</div>'}`
    + `<p style="margin-top:10px"><b>已處理 ${done.length} 項</b>（數據有缺陷，但已喺計算入面修正或排除）</p>${done.map(row).join('')}`;
})()}
<div class="scroll"><table style="margin-top:10px"><thead><tr><th>來源</th><th>行數</th><th>日數</th><th>首日</th><th>末日</th><th>重複</th></tr></thead><tbody>
${D.dataAudit.coverage.map((c) => `<tr><td>${c.fam}</td><td>${c.rows}</td><td>${c.days}</td><td>${c.first}</td><td>${c.last}</td><td class="${c.dup ? 'bad' : 'dim'}">${c.dup}</td></tr>`).join('')}
</tbody></table></div>
<div class="dim" style="font-size:12.5px;margin-top:10px">PMFX 每日 error 行比例（紅 = 有異常）</div>
<div class="spark">${D.series.slice(-60).map((s) => `<i class="${s.err > 0 ? 'e' : ''}" style="height:${Math.max(2, Math.round(100 * s.err / Math.max(1, s.total)))}%" title="${s.date}: ${s.err}/${s.total} 異常"></i>`).join('')}</div>
</div>

<h2 id="s7"><span class="n">7</span>宏觀（最新 Sentinel，${D.macro ? D.macro.date : '—'}）</h2>
<div class="card"><div class="grid">
${D.macro ? Object.entries({ VIX: D.macro.vix, DXY: D.macro.dxy, 'US 10Y': D.macro.us10y, '銅金比': D.macro.cu_au, 'Fear&Greed': D.macro.fng, '平均 Sharpe': D.macro.avg_sharpe }).map(([k, v]) => `<div class="kv"><span>${k}</span><b>${v === '' || v === null ? '—' : v}</b></div>`).join('') : '<div class="dim">（未抽到 summary.md）</div>'}
</div><p class="dim" style="font-size:12.5px">宏觀只有 ${D.dataAudit.coverage.find((c) => c.fam === 'macro')?.days ?? '—'} 日，唔夠做擇時驗證，只作背景。</p></div>

<footer>
<b>方法</b>：數據來自 4 份每日報告（HK quant / US quant / Sentinel / Sentinel PMFX）嘅瘦身投影。所有回報都係訊號之後實際收市價、t+1 入場、扣 ${D.cfg.costPct}% 成本；
價格優先用 HK / US quant 收市，PMFX 只補 FX、期貨、加密。<br>
<b>免責</b>：以上全部係歷史統計同模型輸出，樣本短（約 4 個月），<b>未經實盤驗證</b>，唔構成投資建議。Past performance ≠ future results。
</footer>
</body></html>`;

fs.mkdirSync(DOCS, { recursive: true });
fs.writeFileSync(path.join(DOCS, 'index.html'), html);
console.log(`docs/index.html 已生成（${(Buffer.byteLength(html) / 1024).toFixed(0)} KB）`);
