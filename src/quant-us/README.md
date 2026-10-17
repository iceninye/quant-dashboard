# US Quant Research Project

可直接執行的美股量化研究專案：每日抓取美股市場 Top 100 高交投量股票、下載歷史數據、做回測與模擬、校準 SPY 期權波動率曲面，並輸出 CSV、PNG 與報告。

## 功能
- 每日抓取前 100 隻最高交投量美股 (含防封鎖 Pacing 機制)。
- 自動下載歷史價格與回報。
- 技術指標與回測。
- Historical Simulation / Bootstrap。
- GBM / Heston / Jump-Diffusion。
- SPY 期權波動率曲面校準 (3D Surface)。
- 每隻股票 10/20/50/100/300 天 Monte Carlo 分位表與 Fan Chart。

## 安裝
```
pip install -r requirements.txt
```

## 執行
```
python -m src.main
```
