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
const PN = D.pmfxNew, FW = D.forward;
const pmOpen = PN.settled >= PN.needed;
const pass = D.factors.filter((f) => f.grade === 'pass' && f.market !== 'sentinel');
const watch = D.factors.filter((f) => f.grade === 'watch' && f.market !== 'sentinel');
const bestW = watch.length ? watch[0].byH.filter((h) => h.grade === 'watch').sort((a, b) => b.t - a.t)[0] : null;
const sen = D.factors.find((f) => f.market === 'sentinel');
const pmFilled = D.tracking.filter((t) => t.filled).length;
const okOpp = D.opportunities.filter((o) => o.tier !== 'EXCLUDED');
const oppRow = (o) => `<tr><td class="tk">${esc(o.ticker)}<div class="dim" style="font-size:11.5px">${esc(o.name)}</div></td>
<td class="${o.action === '買' ? 'good' : o.action === '沽' ? 'bad' : 'dim'}">${esc(o.action)}</td>
<td>${fmt(o.close)}</td><td>${fmt(o.entry)}</td><td>${o.close && o.entry ? fmt((o.entry / o.close - 1) * 100, 1) + '%' : '—'}</td>
<td>${fmt(o.upPct)}</td><td>${fmt(o.stopPct)}</td><td>${fmt(o.rr)}</td>
<td class="${o.cons > 0 ? 'good' : o.cons < 0 ? 'bad' : 'dim'}">${fmt(o.cons)}</td><td class="t${o.tier}">${o.tier}</td></tr>`;

const html = `<!DOCTYPE html>
<html lang="zh-Hant"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
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
.tX{color:var(--bad);font-weight:700}
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
<nav><a href="#s1">1 名單</a><a href="#s2">2 因子驗證</a><a href="#s3">3 前向紀錄</a><a href="#s4">4 PMFX 訊號</a><a href="#s5">5 PMFX 追蹤</a><a href="#s6">6 數據核對</a><a href="#s7">7 宏觀</a></nav>

<div class="hero"><h2>今日結論</h2>
${pass.length ? `<b class="good">已通過驗證：${pass.map((f) => esc(f.marketLabel + ' ' + f.label)).join('、')}</b>，名單見 §1。`
  : watch.length ? `<b>今日冇訊號通過驗證。</b>證據最強係 <b class="gwatch">${esc(watch[0].marketLabel + ' ' + watch[0].label)}</b>：
持有 ${bestW.H} 日，頭 20% 平均跑贏等權 <b>${pct(bestW.excess)}</b>（已扣成本；絕對回報 ${pct(bestW.top)} 對等權 ${pct(bestW.ew)}，即係「跌少啲」多過「賺錢」），前半段 ${pct(bestW.isExcess)}、後半段 ${pct(bestW.oosExcess)} 都係正，
但 t = ${fmt(bestW.t)}（單尾 p ${fmt(bestW.p, 3)}；同時測 ${bestW.m} 個檢定，Holm 校正後 p ${fmt(bestW.adjP, 2)}，要 < 0.05 先算通過）→ <b>只列觀察名單，唔係買入訊號</b>。`
  : '<b class="bad">今日冇任何訊號通過或接近驗證門檻。</b>'}
<ul>
<li>PMFX：限價成交嘅 ${pmFilled} 個歷史訊號，5 日平均 <b class="${(D.trackingStats.all.avgR5 || 0) > 0 ? 'good' : 'bad'}">${pct(D.trackingStats.all.avgR5)}</b>，到目標 ${D.trackingStats.all.wins} 個、止損 ${D.trackingStats.all.losses} 個 → <b>唔好跟</b>（§4–5）。</li>
${sen ? `<li>Sentinel「可加倉」對比「減持」：${sen.byH.map((h) => `${h.H} 日 ${pct(h.excess)}`).join('、')}（相對 29 隻等權）→ ${(sen.byH[0].excess || 0) < 0 ? '<b class="bad">跑輸，唔應該當加分</b>' : '有正面作用'}。</li>` : ''}
<li>樣本只有 ${D.factors[0] ? D.factors[0].byH[0].days : '—'} 個有效交易日、一個市況，${D.dataAudit.issues.length} 項數據問題見 §6。所有結論信心偏低。</li>
</ul></div>

<h2 id="s1"><span class="n">1</span>${pass.length ? '已驗證機會名單' : '觀察名單'}</h2>
${D.picks.length ? D.picks.map((p) => `<div class="card"><div><b class="g${p.grade}">${p.grade === 'pass' ? '通過' : '觀察'}</b> · ${esc(p.marketLabel)} ${esc(p.label)} 頭 20% · ${p.date} 收市 ·
<span class="dim">${p.best.H} 日超額 ${pct(p.best.excess)}，贏等權比率 ${p.best.beatRate}%</span></div>
<div class="scroll"><table><thead><tr><th>標的</th><th>收市</th><th>MDD</th><th>波動</th><th>Sharpe</th><th>月回報</th><th>Sentinel</th><th>PMFX</th></tr></thead><tbody>
${p.names.map((x) => `<tr><td class="tk">${esc(x.ticker)}</td><td>${fmt(x.close)}</td><td>${pct(x.mdd, 1)}</td><td>${pct(x.vol, 1)}</td>
<td>${fmt(x.sharpe)}</td><td class="${(x.month || 0) >= 0 ? 'good' : 'bad'}">${pct(x.month, 1)}</td>
<td class="dim">${esc(x.sentinel || '—')}</td><td class="dim">${esc(x.pmfx || '—')}</td></tr>`).join('')}
</tbody></table></div></div>`).join('') : '<p class="dim">冇因子達到觀察級（前後半段都正、t ≥ 1.5）。</p>'}

<h2 id="s2"><span class="n">2</span>因子驗證 — 邊個訊號有前向回報</h2>
<div class="card scroll"><table><thead><tr><th>因子</th><th>市場</th><th>持有</th><th>頭 20%</th><th>等權</th><th>超額</th><th>前半</th><th>後半</th><th>贏等權</th><th>t</th><th>校正 p</th><th>結果</th></tr></thead><tbody>
${D.factors.map((f) => f.byH.map((h, i) => `<tr><td>${i ? '' : esc(f.label)}</td><td class="dim">${i ? '' : esc(f.marketLabel)}</td><td>${h.H} 日</td>
<td>${pct(h.top)}</td><td class="dim">${pct(h.ew)}</td><td class="${h.excess > 0 ? 'good' : 'bad'}">${pct(h.excess)}</td>
<td>${pct(h.isExcess)}</td><td>${pct(h.oosExcess)}</td><td>${h.beatRate}%</td><td>${fmt(h.t)}</td><td class="dim">${h.adjP === null ? '—' : fmt(h.adjP, 2)}</td>
<td class="g${h.grade}">${{ pass: '通過', watch: '觀察', fail: '未通過' }[h.grade]}</td></tr>`).join('')).join('')}
</tbody></table>
<p class="note">方法：訊號日之後第一個收市價入場，持有 5 / 20 個交易日，扣 ${D.cfg.costPct}% 來回成本；每日揀頭 20%（Sentinel 用「可加倉」對「減持」），同當日全體等權比。
樣本按日期切半做前半 / 後半。<b>通過</b> = 前後半都正 + 非重疊窗口 t ≥ ${FT} + <b>Holm 校正</b>（同時測 ${D.factors[0]?.byH[0].m ?? '—'} 個檢定，校正後單尾 p < 0.05）；<b>觀察</b> = 前後半都正但 t 只有 1.5–${FT}，或 t ≥ ${FT} 但校正後唔夠。持有期跨越數據缺口嘅窗口唔計。
20 日只有 1–2 個非重疊窗口，t 計唔到，所以 20 日結果只作參考。</p></div>

<h2 id="s3"><span class="n">3</span>前向紀錄 — 港股低 MDD（事前凍結、事後照記）</h2>
<div class="card"><p>回測用「當日最活躍名單」有倖存者偏差，唯一無偏差嘅證據係<b>事前凍結規則、之後照記</b>。規則 <code>${esc(FW.rule.version)}</code>：
自 ${FW.rule.liveFrom} 起每 ${FW.rule.stepDays} 日曆日簽名一次，按 repo <code>mdd</code> 欄揀頭 ${FW.rule.top} 隻，下一個港股數據日收市入場，持有到下次入場，扣 ${FW.rule.costBps} bps × 換手，對比港股全體等權。
紀錄係 append-only 檔案 <code>data/forward/hk-lowmdd.csv</code>；規則改動要升 version，舊紀錄唔重寫。</p>
<div class="grid"><div class="kv"><span>已結算期數</span><b>${FW.settled}</b></div>
<div class="kv"><span>平均每期超額</span><b class="${(FW.meanExcess || 0) > 0 ? 'good' : 'bad'}">${pct(FW.meanExcess)}</b></div>
<div class="kv"><span>t</span><b>${fmt(FW.t)}</b></div>
<div class="kv"><span>補記（late）</span><b>${FW.lateCount}</b></div></div>
${FW.mismatches.length ? `<p class="warn">⚠ 紀錄同重算唔一致：${FW.mismatches.join('、')}（有人改過紀錄或數據）</p>` : ''}
<div class="scroll"><table><thead><tr><th>簽名日</th><th>入場</th><th>出場</th><th>狀態</th><th>毛回報</th><th>成本</th><th>淨回報</th><th>等權</th><th>超額</th></tr></thead><tbody>
${FW.periods.slice().reverse().map((p) => `<tr><td>${p.signalDate}</td><td>${p.entry || '—'}</td><td>${p.exit || '—'}</td><td class="dim">${{ 'pending-entry': '等入場日', open: '持有中', settled: '已結算' }[p.status]}</td>
<td>${pct(p.gross)}</td><td class="dim">${pct(p.cost)}</td><td>${pct(p.net)}</td><td class="dim">${pct(p.bench)}</td><td class="${(p.excess || 0) > 0 ? 'good' : 'bad'}">${pct(p.excess)}</td></tr>`).join('')}
</tbody></table></div>
<p class="note">統計力：回測每期超額 sd 約 5%，要 |t| = 2 約需 89 期（≈ 7.4 年）。12 個月只有約 13 期，所以頭幾年只可以講「方向一致 / 唔一致」，<b>唔可以講驗證通過</b>。
注意：呢度用 repo 嘅 <code>mdd</code> 欄（約 2 年回撤），同 <code>docs/WFO.md</code> 用嘅 trailing W（63/126/252 日）係兩個唔同嘅訊號定義。</p></div>

<h2 id="s4"><span class="n">4</span>PMFX 今日訊號（未驗證）</h2>
<p class="warn">PMFX 嘅歷史訊號成交後平均蝕錢（§4），跨報告「共識」加分亦未驗證。下表只顯示過咗 quality gate 嘅 ${okOpp.length}/${D.quality.total} 個，<b>唔構成機會</b>。</p>
<details${pmOpen ? " open" : ""}><summary>${okOpp.length} 個過 gate 嘅 PMFX 訊號（預設收埋，修正後結算樣本 ${PN.settled}/${PN.needed}${pmOpen ? `，平均 5 日 ${pct(PN.avgR5)}` : '，未夠重新評估'}）</summary>
<div class="scroll"><table><thead><tr><th>標的</th><th>方向</th><th>收市</th><th>限價 entry</th><th>距收市</th><th>目標%</th><th>止損%</th><th>RR</th><th>共識</th><th>Grade</th></tr></thead><tbody>
${okOpp.map(oppRow).join('')}
</tbody></table></div>
<details><summary>未過 gate 嘅 ${D.opportunities.length - okOpp.length} 個（排除原因）</summary><div class="scroll"><table><tbody>
${D.opportunities.filter((o) => o.tier === 'EXCLUDED').map((o) => `<tr><td class="tk">${esc(o.ticker)}</td><td>${esc(o.action)}</td><td class="bad" style="text-align:left">${esc(o.why.join(' / '))}</td></tr>`).join('')}
</tbody></table></div></details>
</details>

<h2 id="s5"><span class="n">5</span>PMFX 前向追蹤 — 訊號之後實際發生咩事</h2>
<div class="card"><div class="grid">
<div class="kv"><span>追蹤訊號</span><b>${D.tracking.length}</b></div>
<div class="kv"><span>限價有成交</span><b>${pmFilled}</b></div>
<div class="kv"><span>20 日內冇成交</span><b class="dim">${D.tracking.filter((t) => t.outcome === 'unfilled').length}</b></div>
<div class="kv"><span>到目標 / 止損</span><b><span class="good">${D.trackingStats.all.wins}</span> / <span class="bad">${D.trackingStats.all.losses}</span></b></div>
<div class="kv"><span>平均 5 日（扣成本）</span><b class="${(D.trackingStats.all.avgR5 || 0) > 0 ? 'good' : 'bad'}">${pct(D.trackingStats.all.avgR5)}</b></div>
</div>
<div class="scroll"><table style="margin-top:10px"><thead><tr><th>組別 / 累加 gate</th><th>訊號</th><th>已結算</th><th>勝率</th><th>平均 5 日</th><th>平均 20 日</th></tr></thead><tbody>
${[...D.audit.ladder.map((g) => [g.gate, g]), ['每日 net_ev 頭 1 名', D.audit.rankEdge.top1], ['每日 net_ev 尾 1 名', D.audit.rankEdge.bottom1],
  ['全部做多', D.audit.bySide.buy], ['全部做空', D.audit.bySide.sell]].map(([l, g]) => `<tr><td>${esc(l)}</td><td>${g.n}</td><td>${g.decided}</td>
<td class="${(g.winRate || 0) >= 50 ? 'good' : 'bad'}">${g.winRate === null ? '—' : g.winRate + '%'}</td><td>${pct(g.avgR5)}</td><td>${pct(g.avgR20)}</td></tr>`).join('')}
</tbody></table></div>
<p class="note">回報由限價 entry <b>成交之後</b>先計（收市價觸及 entry 先算成交，${D.cfg.fillDays} 個交易日內冇觸及 = 冇成交）。加 gate 之後勝率或回報下跌 = gate 冇用。
2026-10-17 之前嘅 PMFX 行上游有 bug，新版仲未有結算樣本。</p>
<details><summary>最近 40 條訊號</summary><div class="scroll"><table><thead><tr><th>日期</th><th>標的</th><th>方向</th><th>結果</th><th>成交日</th><th>5日</th><th>20日</th></tr></thead><tbody>
${D.tracking.slice(-40).reverse().map((t) => `<tr><td>${t.date}</td><td class="tk">${esc(t.ticker)}</td>
<td class="${t.side > 0 ? 'good' : 'bad'}">${t.side > 0 ? '多' : '空'}</td>
<td class="${t.outcome === 'target' ? 'good' : t.outcome === 'stop' ? 'bad' : 'dim'}">${t.outcome}</td>
<td>${t.fillDay ?? '—'}</td><td>${pct(t.r5)}</td><td>${pct(t.r20)}</td></tr>`).join('')}
</tbody></table></div></details></div>

<h2 id="s6"><span class="n">6</span>數據核對</h2>
<div class="card">
${D.dataAudit.issues.map((i) => `<div class="${i.level}" style="font-size:13.5px;margin:3px 0">${i.level === 'bad' ? '✘' : '⚠'} <b>${esc(i.fam)}</b>：${esc(i.msg)}</div>`).join('')}
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
