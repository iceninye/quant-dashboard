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

const html = `<!DOCTYPE html>
<html lang="zh-Hant"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Quant Dashboard — 4 報告交叉分析</title>
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
</style></head><body>
<h1>Quant Dashboard <span class="dim" style="font-size:13px;font-weight:400">— 4 份報告交叉分析</span></h1>
<div class="sub">PMFX 訊號日 <b>${D.pmfxDate}</b> · 生成 ${new Date(D.generatedAt).toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong' })} HKT ·
HK ${D.dates.hk || '—'} · US ${D.dates.us || '—'} · Sentinel ${D.dates.sen || '—'}</div>

${D.quality.clean === 0 ? `<p class="warn"><b>⚠️ 今日冇一個標的通過 quality gate（0/${D.quality.total}）</b><br>
${D.quality.total} 個標的中：引擎異常 ${D.quality.err} · RR 無效 ${D.quality.rrvInvalid} · 止損退化（&lt;0.3%）${D.quality.degenerate}。
下面嘅 EV 數字係「未過關」，只可作參考，<b>唔可以直接跟隨</b>。詳見 §2 Gate 階梯同 §5 數據質量。</p>` : ''}

<h2><span class="n">1</span>今日機會排行</h2>
<div class="card"><div class="grid">
<div class="kv"><span>通過 gate</span><b class="${D.quality.clean ? 'good' : 'bad'}">${D.quality.clean}/${D.quality.total}</b></div>
<div class="kv"><span>引擎異常</span><b class="bad">${D.quality.err}</b></div>
<div class="kv"><span>RR 無效</span><b class="bad">${D.quality.rrvInvalid}</b></div>
<div class="kv"><span>止損退化</span><b class="bad">${D.quality.degenerate}</b></div>
</div></div>
<table><thead><tr><th>標的</th><th>方向</th><th>net_ev</th><th>RR</th><th>止損%</th><th>目標%</th><th>共識</th><th>Sentinel</th><th>Grade</th></tr></thead><tbody>
${D.opportunities.map((o) => `<tr>
<td class="tk">${esc(o.ticker)}<div class="dim" style="font-size:11.5px">${esc(o.name)}</div></td>
<td class="${o.action === '買' ? 'good' : o.action === '沽' ? 'bad' : 'dim'}">${esc(o.action)}</td>
<td>${fmt(o.net_ev)}</td><td>${fmt(o.rr)}</td>
<td class="${o.stopPct !== null && o.stopPct < D.cfg.minStopPct ? 'bad' : ''}">${fmt(o.stopPct)}</td>
<td>${fmt(o.upPct)}</td>
<td class="${o.cons > 0 ? 'good' : o.cons < 0 ? 'bad' : 'dim'}">${fmt(o.cons)}</td>
<td class="dim">${esc(o.risk || '—')}</td>
<td class="t${o.tier === 'EXCLUDED' ? 'X' : o.tier}">${o.tier}</td></tr>
<tr><td colspan="9" class="dim" style="text-align:left;font-size:12px;padding-top:0">
notes: ${esc(o.notes.join(' · ') || '—')}${o.why.length ? ' ｜ 排除原因: <span class="bad">' + esc(o.why.join(' / ')) + '</span>' : ''}</td></tr>`).join('')}
</tbody></table>

<h2><span class="n">2</span>Gate 階梯 — 過濾器真係有效嗎？</h2>
<div class="card"><table><thead><tr><th>累加 gate</th><th>訊號數</th><th>已結算</th><th>勝率</th><th>平均 5 日</th><th>平均 20 日</th></tr></thead><tbody>
${D.audit.ladder.map((g) => `<tr><td>${esc(g.gate)}</td><td>${g.n}</td><td>${g.decided}</td>
<td class="${(g.winRate || 0) >= 50 ? 'good' : 'bad'}">${g.winRate === null ? '—' : g.winRate + '%'}</td>
<td>${pct(g.avgR5)}</td><td>${pct(g.avgR20)}</td></tr>`).join('')}
</tbody></table>
<p class="note">判讀方式：如果「加咗 filter 之後勝率／平均回報上升」，filter 有價值；如果<b>反而下跌</b>，就係過度擬合或 gate 揀錯。<br>
留意最後兩層 <code>n=0</code> — 代表「要求引擎無 error ＋ 止損 ≤5%」之後，<b>歷史上一個訊號都剩唔到</b>。</p></div>

<h2><span class="n">3</span>排名有冇 edge？（net_ev 排名 vs 實際結果）</h2>
<div class="card"><table><thead><tr><th>組別</th><th>訊號</th><th>已結算</th><th>勝率</th><th>平均 5 日</th><th>平均 20 日</th></tr></thead><tbody>
${[['每日 net_ev 頭 1 名', D.audit.rankEdge.top1], ['每日 net_ev 尾 1 名', D.audit.rankEdge.bottom1],
  ['全部做多', D.audit.bySide.buy], ['全部做空', D.audit.bySide.sell]].map(([l, s]) => `<tr><td>${l}</td>
<td>${s.n}</td><td>${s.decided}</td><td class="${(s.winRate || 0) >= 50 ? 'good' : 'bad'}">${s.winRate === null ? '—' : s.winRate + '%'}</td>
<td>${pct(s.avgR5)}</td><td>${pct(s.avgR20)}</td></tr>`).join('')}
</tbody></table>
<p class="note">頭 1 名 vs 尾 1 名如果冇明顯差距 → <b>排名本身冇預測力</b>，唔應該用「EV 最高」做揀股理由。</p></div>

<h2><span class="n">4</span>前向追蹤（訊號之後實際發生咩事）</h2>
<div class="card"><div class="grid">
<div class="kv"><span>追蹤訊號總數</span><b>${D.tracking.length}</b></div>
<div class="kv"><span>已結算（到目標/止損）</span><b>${D.trackingStats.all.decided}</b></div>
<div class="kv"><span>命中目標</span><b class="good">${D.trackingStats.all.wins}</b></div>
<div class="kv"><span>觸及止損</span><b class="bad">${D.trackingStats.all.losses}</b></div>
<div class="kv"><span>整體勝率</span><b>${D.trackingStats.all.winRate === null ? '—' : D.trackingStats.all.winRate + '%'}</b></div>
<div class="kv"><span>平均 5 日回報</span><b>${pct(D.trackingStats.all.avgR5)}</b></div>
</div>
<details><summary>睇最近 40 條訊號嘅結果</summary>
<table><thead><tr><th>日期</th><th>標的</th><th>方向</th><th>結果</th><th>第幾日</th><th>1日</th><th>5日</th><th>20日</th><th>乾淨</th></tr></thead><tbody>
${D.tracking.slice(-40).reverse().map((t) => `<tr><td>${t.date}</td><td class="tk">${esc(t.ticker)}</td>
<td class="${t.side > 0 ? 'good' : 'bad'}">${t.side > 0 ? '多' : '空'}</td>
<td class="${t.outcome === 'target' ? 'good' : t.outcome === 'stop' ? 'bad' : 'dim'}">${t.outcome}</td>
<td>${t.hitDay ?? '—'}</td><td>${pct(t.r1)}</td><td>${pct(t.r5)}</td><td>${pct(t.r20)}</td>
<td>${t.clean ? '✔' : '<span class="dim">✘</span>'}</td></tr>`).join('')}
</tbody></table></details></div>

<h2><span class="n">5</span>數據質量趨勢（每日）</h2>
<div class="card">
<div class="dim" style="font-size:12.5px">每日「引擎異常」訊號數（紅 = 有異常，藍 = 乾淨）</div>
<div class="spark">${D.series.slice(-60).map((s) => `<i class="${s.err > 0 ? 'e' : ''}" style="height:${Math.max(2, Math.round(100 * s.err / Math.max(1, s.total)))}%" title="${s.date}: ${s.err}/${s.total} 異常"></i>`).join('')}</div>
<div class="dim" style="font-size:12.5px;margin-top:8px">每日「止損退化」訊號數</div>
<div class="spark">${D.series.slice(-60).map((s) => `<i class="${s.degenerate > 0 ? 'e' : ''}" style="height:${Math.max(2, Math.round(100 * s.degenerate / Math.max(1, s.total)))}%" title="${s.date}: ${s.degenerate}/${s.total} 退化"></i>`).join('')}</div>
<table style="margin-top:10px"><thead><tr><th>日期</th><th>標的數</th><th>通過 gate</th><th>異常</th><th>退化</th><th>買 / 沽</th><th>最高 net_ev</th></tr></thead><tbody>
${D.series.slice(-14).reverse().map((s) => `<tr><td>${s.date}</td><td>${s.total}</td><td>${s.clean}</td>
<td class="${s.err ? 'bad' : 'dim'}">${s.err}</td><td class="${s.degenerate ? 'bad' : 'dim'}">${s.degenerate}</td>
<td>${s.buys} / ${s.sells}</td><td>${fmt(s.bestEv)}</td></tr>`).join('')}
</tbody></table></div>

<h2><span class="n">6</span>宏觀（最新 Sentinel）</h2>
<div class="card"><div class="grid">
${D.macro ? Object.entries({ VIX: D.macro.vix, DXY: D.macro.dxy, 'US 10Y': D.macro.us10y, '銅金比': D.macro.cu_au, 'Fear&Greed': D.macro.fng, '平均 Sharpe': D.macro.avg_sharpe }).map(([k, v]) => `<div class="kv"><span>${k}</span><b>${v === '' || v === null ? '—' : v}</b></div>`).join('') : '<div class="dim">（未抽到 summary.md）</div>'}
</div></div>

<footer>
<b>方法論</b>：數據來自 4 個每日報告（HK quant / US quant / Sentinel / Sentinel PMFX），只取「瘦身投影」，唔 copy 原始檔。<br>
機會來源 <b>只有 PMFX</b>（唯一提供 entry / target / stop / 期望值）；quant Sharpe、動量、Sentinel 風險只作加成或扣分。<br>
<b>每個 gate 都會用前向追蹤驗證</b>：訊號之後用實際價格計 1/5/20 日回報，睇有冇觸及目標或止損。<br>
${D.quality.clean === 0 ? '<span class="bad">⚠️ 今日 0 個標的通過 gate — 呢個 dashboard 唔會建議你跟任何訊號。</span><br>' : ''}
<b>免責</b>：以上全部係模型輸出（Monte Carlo / 策略投票 / 統計指標），<b>未經交易驗證</b>，唔構成投資建議。Past performance ≠ future results。
</footer>
</body></html>`;

fs.mkdirSync(DOCS, { recursive: true });
fs.writeFileSync(path.join(DOCS, 'index.html'), html);
console.log(`docs/index.html 已生成（${(Buffer.byteLength(html) / 1024).toFixed(0)} KB）`);
