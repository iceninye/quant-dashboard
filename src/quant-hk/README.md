# Quant Research Project

可直接執行的量化研究專案：每日抓取香港市場高交投量股票、下載歷史數據、做回測與模擬、校準期權波動率曲面，並輸出 CSV、PNG 與報告。

## 功能
- 每日抓取 Top 100 高交投量港股。
- 自動下載歷史價格與回報。
- 技術指標與回測。
- Historical Simulation / Bootstrap。
- GBM / Heston / Jump-Diffusion。
- 期權波動率曲面校準。
- Plotly 圖表輸出 PNG。
- 自動圖表目錄與每日總報告。
- 每隻股票 10/20/50/100/300 天分位表與 fan chart。

## 安裝
```
pip install -r requirements.txt
```

## 執行
```
python -m src.main
```
