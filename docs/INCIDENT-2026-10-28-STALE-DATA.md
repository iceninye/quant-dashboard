# 事故記錄 — 數據停擺 / 頁面 stale（診斷 2026-10-28）

> **狀態**：✅ **已修復（2026-10-28 10:00 HKT）** — 詳見 §11
> **影響**：公開頁面 `https://iceninye.github.io/quant-dashboard/` 曾停在 HK/Sentinel 2026-10-16、US/PMFX 2026-10-17，落後 10–11 個日曆日；現已同步到 HK 10-27 / US 10-28 / Sentinel 10-27 / PMFX 10-28
> **調查方式**：全程 read-only（`sync.mjs --dry`、`git log/show`、`ls`、`grep`）；無 commit、無 push、無刪改任何上游檔案

---

## 一句話

**Dashboard 冇任何排程自動 publisher**，`publish.sh` 由 2026-10-17 之後從未執行；2026-10-22 見到嘅「生成時間」只係 feature PR 跑 `build.mjs` 重繪 HTML，**冇跑 `sync.mjs`** —— 所以時間戳新、數據舊。加上上游 `output/` 只保留最新 1–2 日嘅 `metrics_*.csv` / `signals_*.csv`，令單純重跑 sync 只會「跳」到最新一日，中間 19–26/10 斷開。

---

## 1. 症狀對照表

| 家族 | repo shard 最大日 | 頁面顯示 | 上游實測最新 | 落後 |
|---|---|---|---|---|
| HK quant | 2026-10-16 | 10-16 | 2026-10-27 | 7 個交易日 |
| US quant | 2026-10-17 | 10-17 | 2026-10-28 | 7 個交易日 |
| Sentinel | 2026-10-16 | 10-16 | 2026-10-27 | — |
| Sentinel PMFX | 2026-10-17 | 10-17 | 2026-10-28 | 7 個交易日 |
| Macro | 2026-10-16 | — | 2026-10-16 | — |

頁面 header：`生成 22/10/2026 下午9:39:25 HKT · 數據日：HK 2026-10-16 · US 2026-10-17 · Sentinel 2026-10-16 · PMFX 2026-10-17`

**「生成時間」同「數據日」係兩個唔同 pipeline stage**，可以相差任意遠。

---

## 2. 根因 A — `publish.sh` 冇被任何排程觸發

`scripts/publish.sh` 第 2 行自己寫明：

```bash
# publish.sh — 每日同步 + 重建 + 檢查 + push（唔用 cron，手動或由 agent 觸發）
```

實測全部排程通道，**零引用**：

| 通道 | 結果 |
|---|---|
| `crontab -l`（12 條活躍 entry） | 無 `publish.sh` / `sync.mjs` |
| Hermes cron `jobs.json`（19 個 job） | 無；量化相關只有 4 個 compute + 3 個 notify |
| `systemd --user` timer | 無 |
| `.github/workflows/` | 冇呢個目錄 |

`git log` 證據：全部 `data: … 每日同步` commit **集中喺 2026-10-17**，之後再冇任何 `data/` 變動 commit。

---

## 3. 根因 B — 22/10 嘅「生成時間」係誤導

PR #16 `79f326c`（`Show long-sample factor scan on the dashboard (section 2b)`，2026-10-22 21:40）嘅 diff：

```
docs/index.html | 47 +++++++++++++++++++++++++--------------
```

**只有 `docs/index.html`，`data/` 一片都冇動。**

即係當時只跑咗：

```
build.mjs   ← 由既有 data/ 重繪 HTML（更新 render timestamp）
```

而**冇跑**：

```
sync.mjs    ← 由上游抽取新數據寫入 data/
```

所以頁面時戳升到 22/10，但 `data/hk/2026-10.csv` 最後一行仍然係 10-16。

---

## 4. 根因 C — 上游 `output/` 只保留最新 1–2 日（關鍵陷阱）

### 4.1 實測：上游現存嘅 10 月檔案（2026-10-28 09:52 HKT）

| 家族 | 上游現存 10 月日期 | 缺 |
|---|---|---|
| HK `output/data/metrics_*` | 01,02,05,06,07,08,09,12,13,14,15,16,**27** | 19,20,21,22,23,26 |
| US `output/data/metrics_*` | 01,02,03,06,07,08,09,10,13,14,15,16,17,**28** | 20,21,22,23,24,26,27 |
| Sentinel `reports/*/signals_*` | 20,23,27 | 正常（cron = Tue+Fri） |
| PMFX `reports/*/data/signals_*` | **只有 28** | 17–27 全部 |

### 4.2 證明「當日 run 成功、檔案曾經存在」

HK 19–26/10 雖然缺 `metrics_*.csv`，但**同目錄有** `prices_*.csv` 同 `correlation_*.csv`：

```
19-10  metrics:n  prices:Y  corr:Y  summary:n  report:n
20-10  metrics:n  prices:Y  corr:Y  summary:n  report:n
...
26-10  metrics:n  prices:Y  corr:Y  summary:n  report:n
27-10  metrics:Y  prices:Y  corr:Y  summary:Y  report:Y
```

而 `hk_quant_compute.sh` 嘅 `snapshot_copy` 用 `cp -n` 將 `data/metrics_*.csv` **全部**複製入 dated mirror。mirror 快照有齊 → 證明 `metrics_19-10` 等檔案**當時確實存在於上游**，之後消失。

逐日比對 mirror 快照可定出消失時刻：

| mirror 快照 | 內含 10 月 metrics | 推論 |
|---|---|---|
| 19-10 | …16,**19** | 19-10 存在 |
| 20-10 | …16,19,**20** | 19,20 存在 |
| 21-10 | …16,**20,21**（19 已消失） | 19-10 於 20→21/10 之間被移除 |
| 22-10 | …16,21,22 | 20-10 於 21→22/10 之間被移除 |
| 23-10 | …16,22,23 | 21-10 被移除 |
| 26-10 | …16,**26**（23 已消失） | 22,23 被移除 |

→ 上游 `output/data` 對 `metrics_*.csv` 呈現「**只留最新 1–2 日**」行為。

### 4.3 執行者：未證實（誠實記錄）

已徹底搜過，**搵唔到任何刪除程式碼**：

- `quant-hk/src/*.py`、`quant-us/src/*.py`、`sentinel/src`、`sentinel-pmfx/src`：無 `os.remove` / `unlink` / `shutil.rmtree` / retention / prune
- `~/.hermes/scripts/*.sh`：`hk_quant_notify.sh` / `us_quant_notify.sh` 只讀 metrics 去發送，**唔刪**
- `wsl_quant_cleanup.sh`：只 `rm -rf` `~/hermes reports/*` 嘅過期 **dated 目錄**（10 日 retention），**唔碰** `~/hermes-projects/*/output`
- `hk_quant_compute.sh` 全 106 行：唯一 `mv` 係將 iCloud 舊 dated 目錄歸檔

時間巧合（但未構成證據）：`output/data` 目錄 mtime 分別係 HK `10-27 18:21`（notify 18:20 之後）、US `10-28 08:10`（notify 08:05 之後）。

→ **列為 TODO**：加 audit，實際捕捉刪除者身份（見 §9）。

---

## 5. 為何重跑 sync 唔會自動補回

`scripts/lib/sources.mjs` 硬編碼四條上游路徑，**唔讀 mirror、唔讀 iCloud**：

```js
export const SRC = {
  hk:       path.join(HOME, 'hermes-projects/quant-hk/output'),
  us:       path.join(HOME, 'hermes-projects/quant-us/output'),
  sentinel: path.join(HOME, 'hermes-projects/sentinel/reports'),
  pmfx:     path.join(HOME, 'hermes-projects/sentinel-pmfx/reports'),
  icloud:   '/mnt/c/Users/ice_n/iCloudDrive/Hermes Reports',   // 有定義但 sync 唔用
};
```

`node scripts/sync.mjs --days=120 --dry` 實測輸出：

```
HK quant: 來源 58 日, 新 1 日, 98 行 (dry)
US quant: 來源 58 日, 新 2 日, 99 行 (dry)
Sentinel: 來源 27 日, 新 3 日, 87 行 (dry)
PMFX:     來源 60 日, 新 1 日, 36 行 (dry)
Macro:    3 行 (dry)
```

→ 直接跑只會令四家「跳」到最新一日，HK/PMFX 中間 19–26/10 留洞；forward tracking（1/5/10/20 日）會因缺中間交易日而樣本斷裂。

---

## 6. 完整備份素材（可補齊）

| 家族 | `~/hermes reports/` mirror | iCloud `archive/2026-10/` | 覆蓋 19–26/10 |
|---|---|---|---|
| HK quant | `Quant Research/<dd>-10-2026/data/metrics_*.csv` | `quant-hk/` | ✅ 19,20,21,22,23,26 全有 |
| US quant | `Quant Research US/<dd>-10-2026/data/` | `quant-us/` | ⚠️ 有 20,21,22,23,24；**缺 19,26**（週一，US cron Tue–Sat，本來冇 run）|
| Sentinel | `Sentinel/<dd>-10-2026/signals_*.csv` | `sentinel/` | ✅ 只有 20,23（Tue/Fri，正常）|
| PMFX | `Sentinel PMFX/<dd>-10-2026/data/signals_*.csv` | `pmfx/` | ✅ 19,20,21,22,23,26 全有 |

**結論：HK 同 PMFX 嘅 19–26/10 缺口 100% 可補，無資料永久損失。**

各家最新日期（2026-10-28 09:52）：

| 家族 | 最新可得 | 備註 |
|---|---|---|
| HK | 2026-10-27 | 28-10 要等今晚 18:00 |
| US | 2026-10-28 | 今朝 07:45 已跑 |
| Sentinel | 2026-10-27 | 下次 30-10（Fri）|
| PMFX | 2026-10-28 | |

→ **四家共同最新日 = 2026-10-27**（可以做一致 headline，唔需要四家全部 28-10）。

---

## 7. 修復計劃（待批，未執行）

| Plan | 內容 | 風險 | 影響 |
|---|---|---|---|
| **A** | 直接 `publish.sh` | 🟡 | 四家跳到最新日，但 HK/PMFX 19–26/10 有洞，forward tracking 樣本斷裂 |
| **B** | 由 mirror/iCloud 將缺嘅 `metrics_*` / `signals_*` **copy**（唔 move、唔刪原件）返上游 → `sync` → `build` → `check` → push | 🟡 | 走勢連續、forward tracking 完整；代價係要寫入上游 `output/` |
| **C** | Hermes cron 加 `publish.sh`，排喺四個 compute + notify 全部完成後（建議 21:30） | 🟢 | 根治「乾涸」，唔會再靜靜停擺 |
| **D** | 改 `sources.mjs` 加 mirror fallback | 🔴 | 一勞永逸，但動核心資料層，要獨立回歸測試 |

**建議組合：B + C**（先補齊再上排程）。

正確次序（強制）：
```
git pull --ff-only      # 已完成 2026-10-28（72d92db → 08be86d）
Plan B 補檔
node scripts/sync.mjs --days=120
node scripts/build.mjs
node scripts/check.mjs
git add data/ docs/ && git commit && git push
```

**注意**：唔可以先 pull 之前跑 `publish.sh` —— 舊 `build.mjs`（+30 行新版先有 section 2b）會用舊邏輯覆蓋 `docs/index.html`，抹走 factor scan，造成 regression。

---

## 8. Gate / 資料契約（修復時不得放寬）

- 機會條目**只可以由 PMFX 提供** entry / target / stop / EV
- Quant Sharpe、Sentinel risk **只可以做加減分**，唔可以產生條目
- 入選必須同時滿足：`rr_valid=1`、`net_rr_valid=1`、stop 距離 0.3–12%、`net_ev>0`、`error` 為空
- 必須有 1 / 5 / 10 / 20 日前向追蹤（實際回報 + target/stop 結果）
- **唔可以**為咗令 stale 數據看起來「夠新」而放寬 gate

---

## 9. TODO（未完成）

| # | 項目 | 優先 |
|---|---|---|
| 1 | 定位上游 `output/data` retention 執行者（現時無任何刪除程式碼，行為未證實） | 高 |
| 2 | 加 `inotify` / `auditd` watch 捕捉刪除者，或喺 notify 前後做 checksum 快照 | 中 |
| 3 | Hermes cron 加 dashboard publish（Plan C） | 高 |
| 4 | `sources.mjs` 加 mirror fallback（Plan D，需獨立測試） | 低 |
| 5 | 清理 repo 內 6 個 untracked 診斷腳本（`scripts/diag2.mjs`、`diag3.mjs`、`diag_backfill.mjs`、`show_tables.mjs`、`verify_backfill.mjs`、`verify_backfill2.mjs`）| 低 |

---

## 10. 驗證命令（複製即用）

```bash
cd ~/quant-dashboard

# 1) 頁面實際數據日
git show HEAD:docs/data/dashboard.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('generatedAt'))"

# 2) repo 每家最大日
for f in hk us sentinel pmfx macro; do
  printf "%-9s max=" "$f"
  cat data/$f/*.csv | grep -v '^date' | cut -d, -f1 | grep -E '^20' | sort | tail -1
done

# 3) sync 會見到幾多日（dry run，安全）
node scripts/sync.mjs --days=120 --dry

# 4) 上游 / mirror 存在矩陣
for d in 19 20 21 22 23 26 27; do
  printf "%s-10 HK(u%s m%s) PMFX(u%s m%s)\n" "$d" \
    $([ -f ~/hermes-projects/quant-hk/output/data/metrics_$d-10-2026.csv ] && echo Y || echo n) \
    $([ -f "/home/wsluser/hermes reports/Quant Research/$d-10-2026/data/metrics_$d-10-2026.csv" ] && echo Y || echo n) \
    $([ -f ~/hermes-projects/sentinel-pmfx/reports/$d-10-2026/data/signals_$d-10-2026.csv ] && echo Y || echo n) \
    $([ -f "/home/wsluser/hermes reports/Sentinel PMFX/$d-10-2026/data/signals_$d-10-2026.csv" ] && echo Y || echo n)
done
```

---

## 11. 修復執行記錄（2026-10-28 09:53–10:00 HKT）

### 11.1 執行步驟

| # | 動作 | 結果 |
|---|---|---|
| 1 | `git pull --ff-only` | `72d92db` → `08be86d`（帶入 PR #16：`build.mjs` +30、`check.mjs` +8、`docs/data/scan.json`）|
| 2 | Plan B：由 mirror 補檔（`cp -p`，只新增、零覆蓋、零刪除） | **25 個檔**：HK `metrics_*`+`summary_*` 各 6（19,20,21,22,23,26-10）、PMFX `signals_*` 7（19,20,21,22,23,26,27-10）、US `metrics_*` 6（20,21,22,23,24,27-10）；`missing=0` |
| 3 | `node scripts/sync.mjs --days=120` | `data/*/2026-10.csv` **+1757 行、0 刪除**；repo 1.54 MB → 1.72 MB（預算 20 MB）|
| 4 | `node scripts/build.mjs` | `docs/data/dashboard.json` 737 KB、`docs/index.html` 48 KB |
| 5 | `node scripts/check.mjs` | **84 通過 / 0 失敗** |
| 6 | commit `f0be72f` + push | 只 add `data/` `docs/`，**確認無夾帶** untracked 診斷腳本 |
| 7 | Plan C：新增 `~/.hermes/scripts/quant_dashboard_publish.sh` + Hermes cron `4dbb2def8d63`（`30 21 * * 1-6`）| 今晚 21:30 首跑 |
| 8 | 驗證線上 | `HTTP 200`，頁面顯示 `數據日：HK 2026-10-27 · US 2026-10-28 · Sentinel 2026-10-27 · PMFX 2026-10-28` |

### 11.2 US 只補 6 日（唔係 8 日）嘅原因

US cron = `45 7 * * 2-6`（Tue–Sat）。`19-10` 同 `26-10` 都係**週一**，美國本來就冇 run，唔算缺口。

### 11.3 為何另寫 `quant_dashboard_publish.sh` 而唔用 repo 內 `scripts/publish.sh`

`publish.sh` 第 11 行係 `git add -A` —— 會連 repo 內任何 untracked 殘留檔（現時有 6 個：`scripts/diag2.mjs`、`diag3.mjs`、`diag_backfill.mjs`、`show_tables.mjs`、`verify_backfill.mjs`、`verify_backfill2.mjs`）一齊 commit 上公開 repo。

新腳本改為：

- 只 `git add data/ docs/`
- 額外加防護：若 `git diff --cached` 出現 `scripts/diag*` / `verify_backfill*` / `show_tables*` → `git reset` 並 abort
- 先 `git pull --ff-only`（避免遠端有 PR merge 後 push 被拒）
- `sync → build → check` 任一步失敗即 `exit` 唔 push，保留現場
- 完整輸出寫 `~/.hermes/logs/quant_dashboard_publish.log`（>5 MB rotate），**stdout 只留一行摘要** → 成功靜默、失敗由 cron 發 error alert
- 排程 `30 21 * * 1-6`（在 HK 18:00 / PMFX 19:15 / US 07:45 / Sentinel 08:15 之後）

### 11.4 修復後狀態

| 項目 | 修復前 | 修復後 |
|---|---|---|
| 頁面生成時間 | 22/10 21:39 | 28/10 09:56 |
| HK 數據日 | 2026-10-16 | **2026-10-27** |
| US 數據日 | 2026-10-17 | **2026-10-28** |
| Sentinel 數據日 | 2026-10-16 | **2026-10-27** |
| PMFX 數據日 | 2026-10-17 | **2026-10-28** |
| repo 資料體積 | 1.54 MB | 1.72 MB（預算 20 MB）|
| check 契約 | — | 84 / 0 失敗 |
| 自動 publisher | ❌ 無 | ✅ cron `4dbb2def8d63` |

### 11.5 已知殘留（未修，需注意）

- `trackingStats.clean = {signals: 164, decided: 0}` —— PMFX 歷史行 `error` 欄非空（2026-06-18 至 2026-10-16 上游 bug，2304/2628 行），被 gate 排除；乾淨訊號由 2026-10-17 才開始，未夠日數決定。**唔可以靠補檔解決**，屬歷史資料本質限制。
- 上游 `output/data` retention 執行者仍未定位（§4.3、§9 TODO #1）。
