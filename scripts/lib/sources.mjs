// 四個報告來源嘅定位 + 正規化。全部只用「瘦身投影」，唔 copy 原始檔。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseCsv, num, r } from './csv.mjs';

const HOME = os.homedir();
export const SRC = {
  hk: path.join(HOME, 'hermes-projects/quant-hk/output'),
  us: path.join(HOME, 'hermes-projects/quant-us/output'),
  sentinel: path.join(HOME, 'hermes-projects/sentinel/reports'),
  pmfx: path.join(HOME, 'hermes-projects/sentinel-pmfx/reports'),
  icloud: '/mnt/c/Users/ice_n/iCloudDrive/Hermes Reports',
};

const read = (p) => fs.readFileSync(p, 'utf8');
const ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };

// dd-mm-YYYY → YYYY-MM-DD
export function dmyToIso(s) {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
export function isoToDmy(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
export const monthOf = (iso) => iso.slice(0, 7);

// ---------- HK / US quant ----------
// 來源：output/data/metrics_<dd-mm-YYYY>.csv（+ summary_<dd-mm-YYYY>.md 取 run 統計）
export function quantDates(which) {
  const dir = path.join(SRC[which], 'data');
  const out = new Map();
  for (const f of ls(dir)) {
    const m = /^metrics_(\d{2}-\d{2}-\d{4})\.csv$/.exec(f);
    if (!m) continue;
    const iso = dmyToIso(m[1]);
    if (iso) out.set(iso, path.join(dir, f));
  }
  return out;
}
export function quantRows(which, file, iso) {
  return parseCsv(read(file)).map((x) => ({
    date: iso,
    ticker: x.ticker,
    close: r(x.last_price, 4),
    sharpe: r(x.sharpe, 4),
    cagr: r(x.cagr, 6),
    vol: r(x.volatility, 6),
    mdd: r(x.max_drawdown, 6),
    week: r(x.week_return, 6),
    month: r(x.month_return, 6),
    beta: r(x.beta, 4),
    var95: r(x.var_95, 6),
  }));
}
export function quantMeta(which, iso) {
  const f = path.join(SRC[which], `summary_${isoToDmy(iso)}.md`);
  const t = (() => { try { return read(f); } catch { return ''; } })();
  const g = (re) => { const m = re.exec(t); return m ? m[1] : null; };
  return { tickers: g(/Tickers:\s*(\d+)\/(\d+)/), rf: g(/Risk-Free Rate:\s*([\d.]+)%/), paths: g(/MC Paths:\s*([\d,]+)/) };
}

// ---------- Sentinel（港股/美股風險監控）----------
export function sentinelDates() {
  const out = new Map();
  for (const d of ls(SRC.sentinel)) {
    const iso = dmyToIso(d);
    if (!iso) continue;
    const f = path.join(SRC.sentinel, d, `signals_${d}.csv`);
    if (fs.existsSync(f)) out.set(iso, f);
  }
  return out;
}
export function sentinelRows(file, iso) {
  return parseCsv(read(file)).map((x) => ({
    date: iso,
    ticker: x.ticker,
    name: x.name,
    market: x.market,
    sector: x.sector,
    close: '',
    sharpe: r(x.sharpe, 4),
    vol: r(x.volatility, 6),
    mdd: r(x.max_drawdown, 6),
    week: r(x.week_return, 6),
    month: r(x.month_return, 6),
    action: x.action,
    risk: x.risk_level,
    risk_text: x.risk_level_text,
  }));
}

// ---------- Sentinel PMFX（多資產 26-36 標的）----------
export function pmfxDates() {
  const out = new Map();
  for (const d of ls(SRC.pmfx)) {
    const iso = dmyToIso(d);
    if (!iso) continue;
    const f = path.join(SRC.pmfx, d, 'data', `signals_${d}.csv`);
    if (fs.existsSync(f)) out.set(iso, f);
  }
  return out;
}
// PMFX 有部分標的價位用「每單位」計（GC=F 等），entry/last 直接照抄，唔做換算
// 注意：17-10 起有 schema 漂移（缺 source / quant_sharpe）→ 一律當 optional
export function pmfxRows(file, iso) {
  return parseCsv(read(file))
    .filter((x) => x.ticker)
    .map((x) => ({
      date: iso,
      ticker: x.ticker,
      name: x.name,
      action: x.action,
      votes: x.vote_score,
      opp: r(x.opportunity_score, 4),
      close: r(x.last_price, 6),
      entry: r(x.entry_price, 6),
      target: r(x.target_price, 6),
      stop: r(x.stop_loss, 6),
      rr: r(x.reward_risk, 4),
      rrv: /^true$/i.test((x.rr_valid || '').trim()) ? 1 : 0,
      net_rr: r(x.net_rr, 4),
      net_rrv: /^true$/i.test((x.net_rr_valid || '').trim()) ? 1 : 0,
      ev: r(x.expected_value, 4),
      net_ev: r(x.net_ev, 4),
      atr: r(x.atr14, 6),
      stop_pct: (() => {
        const e = num(x.entry_price), s = num(x.stop_loss);
        return e && s && e > 0 ? ((e - s) / e * 100).toFixed(3) : '';
      })(),
      rank: x.rank,
      source: x.source || '',
      sharpe: r(x.quant_sharpe, 4),
      err: (x.error || '').trim() ? 1 : 0,
    }));
}

// ---------- 宏觀（由 Sentinel summary.md 抽）----------
export function sentinelMacro(iso) {
  const d = isoToDmy(iso);
  const f = path.join(SRC.sentinel, d, `summary_${d}.md`);
  let t = '';
  try { t = read(f); } catch { return null; }
  const g = (re) => { const m = re.exec(t); return m ? m[1].trim() : ''; };
  const row = {
    date: iso,
    vix: r(g(/VIX\*\*:\s*([\d.]+)/), 3),
    dxy: r(g(/DXY\*\*:\s*([\d.]+)/), 3),
    us10y: r(g(/US 10Y\*\*:\s*([\d.]+)/), 3),
    cu_au: r(g(/銅金比\*\*:\s*([\d.]+)/), 6),
    fng: r(g(/Fear & Greed\*\*:\s*([\d.]+)/), 0),
    n_symbols: g(/標的:\s*(\d+)/),
    n_buy: g(/買:\s*(\d+)/),
    n_sell: g(/沽:\s*(\d+)/),
    n_hold: g(/觀望:\s*(\d+)/),
    avg_sharpe: r(g(/平均 Sharpe:\s*(-?[\d.]+)/), 4),
    winrate: r(g(/勝率:\s*([\d.]+)%/), 2),
  };
  return row.vix === '' && row.n_symbols === '' ? null : row;
}

// ---------- helpers ----------
export function listDates(map, days) {
  const today = new Date();
  const cutoff = new Date(today.getTime() - days * 864e5).toISOString().slice(0, 10);
  return [...map.keys()].filter((d) => d >= cutoff).sort();
}
