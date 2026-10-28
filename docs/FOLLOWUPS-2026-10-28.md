# 跟進事項 — 2026-10-28 事故後遺留

> 對應事故記錄：[`INCIDENT-2026-10-28-STALE-DATA.md`](INCIDENT-2026-10-28-STALE-DATA.md)
> 狀態：2026-10-28 建立 · 全部已落地或已安排監測

---

## 已完成（本次同步處理）

| # | 事項 | 狀態 | 落地方式 |
|---|---|---|---|
| F1 | 補 19–26/10 缺口 | ✅ 完成 | `cp -p` 25 檔入上游；`data/` +1757 行、0 刪除；check 84/0 |
| F2 | 每日 publisher 排程 | ✅ 完成 | Hermes cron `4dbb2def8d63`（`30 21 * * 1-6`）→ `~/.hermes/scripts/quant_dashboard_publish.sh` |
| F3 | 零噪音 commit | ✅ 完成 | `~/.hermes/scripts/quant_dashboard_has_change.py`：只有 `generatedAt` / 「生成 <時間>」變 → 還原 `docs/`、唔 commit。四情境已驗證 |
| F4 | untracked 診斷腳本 | ✅ 完成 | 6 個搬出 repo → `~/.hermes/scripts/quant-dashboard-diag/`；wrapper `quant-diag.sh`（已實測 `show_tables` / `verify_backfill2` 跑通）。repo 工作區現時**完全乾淨** |
| F5 | 避免 `git add -A` 夾帶 | ✅ 完成 | 新 publisher 只 `git add data/ docs/` + cached-name 白名單攔截（見到 `scripts/diag*` 即 `git reset` + abort）|

---

## 監測中（每日自動）

| # | 事項 | 狀態 | 監測方式 |
|---|---|---|---|
| M1 | **上游 retention 執行者未定位** | 🟡 監測中 | Hermes cron `3732160463e8`（`0 9 * * *`）→ `~/.hermes/scripts/quant_canary_watch.sh`。25 個 canary 檔（我手動補入嘅歷史檔）每日記錄存在 + size + sha256；任何消失／改寫 → exit 2 + 報警。基線已建立（25/25 在） |

**M1 詳情**：

- 已實查排除：`hk_quant_compute.sh`(106 行) / `us_quant_compute.sh`(107) / `pmfx_compute.sh`(73) → grep `rm`/`find -delete`/`unlink`/`mv *data` **零命中**；`*_notify.sh` 只讀；`wsl_quant_cleanup.sh` 只清 `~/hermes reports/*` dated 目錄；`report_deployer.py` 只複製去 iCloud；上游 4 個 `src/*.py` 無 `remove`/`unlink`/`rmtree`
- **執行者未證實** → 唔虛構 cause。已改用自然實驗捕捉
- ⚠️ 2026-10-28 10:00 前嘅 `output/data` ctime/mtime 線索（HK `10-27 18:21`、US `10-28 08:10`）**已被 `cp -p` 補檔改動而失效**，唔可以再當證據
- 下一步（若 M1 報警）：用 `inotifywait`（本機**未裝** inotify-tools）或改用 `find -newer` + 審計追實際寫入者

---

## 需時間累積（等數據自然成熟）

| # | 事項 | 現況 | 預計可結算 |
|---|---|---|---|
| W1 | **乾淨訊號前向追蹤零結算** | `trackingStats.clean = {signals:164, decided:0, wins:0, losses:0, winRate:null, avgR5:null}` | 最早一批（2026-10-17）約 **2026-11 月中** |

**W1 詳情**（實測 `forwardTrack()` 逐條查）：

| 指標 | 數字 |
|---|---|
| 全部追蹤訊號 | 1,695（clean 164 + dirty 1,531）|
| clean 日期範圍 | 2026-10-17 → 2026-10-28 |
| clean outcome 分佈 | **全部 `pending`（164/164）** |
| clean 已成交 | 2 條（10-17 一條、10-20 一條）|
| clean decided | **0** |

**點解係 0（唔係 bug）**：`engine.mjs` L26 `fillDays=20`；L196 目標／止損要成交後 20 個交易日內觸及才算結算。最舊 clean 訊號只觀察到 **8 個交易日**（`daysObs=8`）→ 全部仍在窗口內。

**頁面處理正確**：gate 階梯表「+ 引擎無 error」一行顯示 `164 訊號 / 0 已結算 / 勝率「—」`，**冇砌假數字**。

---

## ⚠️ 已標記為「不可引用」的數字

頁面「全部有 EV 訊號」一行：**1,695 訊號 / 429 已結算 / 勝率 3.3% / 平均 5 日 −1.99%**

**呢組數字唔可以引用**。429 條結算**全部**來自 2026-10-17 之前嘅壞訊號（`stop` 415 條、`target` 14 條、`timeout` 169 條、`unfilled` 614 條）。上游 PMFX 喺 2026-06-18 → 2026-10-16 有 bug（`error` 欄非空），該期間訊號質量不可信。

頁面已有 caveat：「2026-10-17 之前嘅 PMFX 行上游有 bug，新版仲未有結算樣本」。**唯一可引用嘅前向追蹤數字係 `trackingStats.clean`**，而佢目前為空（見 W1）。

**另一個待觀察指標**：clean 成交率暫時 2/164 = 1.2%（觀察 8 日）；dirty 歷史組約 40%（614/1531 unfilled）。差異大概率係觀察期太短，**唔可以斷定 entry 離市價太遠**；等 20 日期滿再判斷。

---

## 待決（需用戶拍板）

| # | 事項 | 選項 | 風險 |
|---|---|---|---|
| D1 | `sources.mjs` 加 mirror fallback | A：維持現狀（mirror 只作補洞原料）· B：改 `sources.mjs` 讀 mirror（一勞永逸，但要獨立回歸測試） | 🟢 / 🔴 |
| D2 | `pmfxNew.needed = 20` 門檻 | 保持 20（保守，需等 20 條結算）· 降到 10（早啲見數據但樣本薄）| 🟢 / 🟡 |
| D3 | 6 個診斷腳本長遠去向 | 留喺 `~/.hermes/scripts/quant-dashboard-diag/`（現狀）· 正式入 repo `scripts/diagnostics/`（公開，但會令 repo 有診斷碼）| 🟢 / 🟡 |

---

## 復現／核實命令

```bash
# M1 canary 現況
~/.hermes/scripts/quant_canary_watch.sh
cat ~/.hermes/state/quant_canary/snapshot.tsv | head -30

# F3 零噪音判定（exit 10 = 只有時間戳；exit 0 = 有實質變動）
~/.hermes/scripts/quant_dashboard_has_change.py ~/quant-dashboard

# W1 前向追蹤逐條查（clean 全部 pending？）
cat > /tmp/track_probe.mjs <<'EOF'
import * as E from '/home/wsluser/quant-dashboard/scripts/engine.mjs';
const t = E.forwardTrack(E.loadAll());
const clean = t.filter(x => x.clean);
const oc = a => a.reduce((m,x)=>(m[x.outcome]=(m[x.outcome]||0)+1,m),{});
console.log('clean', clean.length, JSON.stringify(oc(clean)));
console.log('decided', clean.filter(x=>['target','stop','timeout'].includes(x.outcome)).length);
EOF
node /tmp/track_probe.mjs

# F4 診斷腳本（已搬出 repo）
~/.hermes/scripts/quant-diag.sh show_tables.mjs
~/.hermes/scripts/quant-diag.sh verify_backfill2.mjs

# 排程現況
python3 -c "import json;[print(j['id'],j.get('name'),j.get('schedule',{}).get('expr'),j.get('next_run_at')) for j in json.load(open('/home/wsluser/.hermes/cron/jobs.json'))['jobs'] if 'quant' in (j.get('name') or '').lower()]"
```
