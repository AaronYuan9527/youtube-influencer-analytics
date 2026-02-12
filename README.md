# VGV KOL Radar Engine（完整版）

這是一套「內部選 KOL 的決策工具」：
- 觀眾地區（regionCode）× 內容語言（relevanceLanguage）× 行銷品類（語意規則）
- 產出 TOP 100 決策池
- 前端：GitHub Pages（index.html）
- 後端：Cloudflare Worker（安全保存 YouTube API Key，不暴露在前端）

---

## 1) 你會得到什麼
- 一個可以直接開的內部工具頁：
  - 可選地區 / 語言 / 行銷品類 / 期間
  - 一鍵生成 TOP 100（Decision Score 排序）
  - 可快速搜尋、匯出 CSV
- 一個 Worker API：
  - /ping 測試連線
  - /top100 生成榜單（自動快取、控制成本）

---

## 2) 部署後端（Cloudflare Worker）

### (A) 安裝 Wrangler
需要 Node.js 18+：
```bash
npm i -g wrangler
wrangler login
```

### (B) 進入 worker 資料夾（本套件根目錄已含 worker.js / wrangler.toml）
```bash
wrangler deploy
```

### (C) 設定 YouTube API Key（用 secret，最安全）
```bash
wrangler secret put YT_API_KEY
# 依提示貼上你的 key（不要提交到 Git）
```

部署成功後，你會得到一個網址（例如）：
`https://vgv-kol-radar.<你的帳號>.workers.dev`

---

## 3) 部署前端（GitHub Pages）
把 `index.html` 放到 GitHub repo 根目錄，並開啟 Pages：
- Settings → Pages
- Branch: main
- Folder: /(root)

Pages 產生後，打開你的網站，在下方「Worker API Base」貼上 Worker 網址並儲存，按「測試連線」。

---

## 4) 如何解讀指標（給內部用）

### VGV Decision Score（0~100）
- 觸及（近期間平均觀看） 35%
- 互動率 30%
- 成長動能 20%
- 觀看穩定 10%
- 留言活躍 5%

### Tier
- A: score ≥ 80（優先合作）
- B: 65–79（可談、視預算）
- C: 50–64（備選池）
- D: < 50（除非有特殊策略）

---

## 5) 注意事項（重要）
- 這是「內部決策池」不是官方 YouTube 排行榜。
- YouTube Data API 有 quota 限制：本工具透過「少量 query + 少頁擴池 + 先粗排再精算 + 快取」控制成本。
- 若你要做到「每天固定自動產出」或「多市場全量跑」，建議再加：KV/DB 落地 + 排程（cron triggers）——可以在 Phase 2 做。

---

## 6) Phase 2（可升級）
- 追蹤訂閱數/觀看數歷史（真實成長率）
- 加入「KOL 受眾輪廓」與「品牌安全」檢核
- 多品類同時產出（一次生成 7 個 TOP100）
