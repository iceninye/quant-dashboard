# 四份報告嘅原始碼（快照）

> **同步日期**：2026-10-17　　來源：`~/hermes-projects/<project>/`（本機實際運行版本）
> 呢度係**副本（snapshot）**，唔係 submodule — 本機改完唔會自動同步，要重新 copy。

## 收錄內容

| Project | 路徑 | 檔案 | 總行數 | 入口 |
|---|---|---|---|---|
| `quant-hk` | `~/hermes-projects/quant-hk/` | `src/*.py` × 4 + `requirements.txt` + `README.md` | 1,255 | `src/main.py` |
| `quant-us` | `~/hermes-projects/quant-us/` | `src/*.py` × 4 + `requirements.txt` + `README.md` | 1,171 | `src/main.py` |
| `sentinel` | `~/hermes-projects/sentinel/` | `src/*.py` × 4 + `templates/` + `requirements.txt` | 1,088 | `src/main.py` |
| `sentinel-pmfx` | `~/hermes-projects/sentinel-pmfx/` | `main.py` + `src/*.py` + `configs/config.yaml` + `verify_fix.py` | 1,588 | `main.py` |

## 刻意唔收錄

| 排除項 | 原因 |
|---|---|
| `output/`、`reports/`、`data/`、`raw/`、`charts/` | 係產出數據（幾百 MB），唔屬原始碼 |
| `.venv*`、`__pycache__` | 環境 |
| cron 腳本（`~/.hermes/scripts/*.sh`）| 內含個人 WhatsApp JID / iCloud 路徑，唔適合公開 |
| `.env`、任何 key / token | **永不入 repo** |

## 已做安全掃描（2026-10-17）

- `grep` 全部 `.py` / `.yaml`：**冇** API key、token、password、email、電話號碼硬編碼
- 所有敏感值都係 `os.environ` / `os.getenv` 讀取（例：Twelve Data key）
- 只含公開 URL（Yahoo Finance、finviz、HKEX、CNN fear&greed、gold-api）同 ticker 清單

## 執行前提（本機）

```bash
# quant-hk / quant-us / sentinel
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

# sentinel-pmfx（用獨立 venv）
python3 -m venv .venv-pmfx && .venv-pmfx/bin/pip install -r requirements.txt
.venv-pmfx/bin/python main.py                 # 完整跑（會寫 reports/<今日>/）
.venv-pmfx/bin/python verify_fix.py           # 只讀回歸測試（2026-10-17 修復用）
```

詳細結構 / 欄位字典 / 函數行號 → [docs/PIPELINE.md](../docs/PIPELINE.md)、[docs/REPORTS.md](../docs/REPORTS.md)
2026-10-17 修復記錄 → [docs/FIXES.md](../docs/FIXES.md)

（網上版：<https://iceninye.github.io/quant-dashboard/PIPELINE.md>）
