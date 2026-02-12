# YouTube 影響力數據分析工具 - GitHub Pages 部署指南

## 🚀 部署步驟

### 步驟 1: 建立 GitHub 帳號（如果還沒有）
1. 前往 [GitHub](https://github.com)
2. 點擊右上角「Sign up」註冊帳號
3. 完成郵箱驗證

### 步驟 2: 建立新的 Repository（儲存庫）
1. 登入 GitHub 後，點擊右上角的 **「+」** → **「New repository」**
2. 填寫以下資訊：
   - **Repository name**: `youtube-influencer-analytics` （或任何你喜歡的名稱）
   - **Description**: `YouTube 影響力數據分析工具 - VGV 圈粉行銷科技`
   - 選擇 **Public**（公開）
   - ✅ 勾選 **「Add a README file」**
3. 點擊 **「Create repository」**

### 步驟 3: 上傳 HTML 檔案
有兩種方法可以上傳檔案：

#### 方法 A: 網頁介面上傳（簡單）
1. 在你的 repository 頁面，點擊 **「Add file」** → **「Upload files」**
2. 將 `youtube-influencer-tool.html` 拖曳到上傳區域
3. 將檔案**重新命名為 `index.html`**（這很重要！）
4. 在下方的 "Commit changes" 輸入訊息：`Add YouTube analytics tool`
5. 點擊 **「Commit changes」**

#### 方法 B: 使用 Git 命令列（進階）
```bash
# 1. 複製 repository 到本地
git clone https://github.com/你的帳號名稱/youtube-influencer-analytics.git

# 2. 進入資料夾
cd youtube-influencer-analytics

# 3. 將 youtube-influencer-tool.html 複製到這個資料夾，並重新命名為 index.html
cp /path/to/youtube-influencer-tool.html index.html

# 4. 加入檔案
git add index.html

# 5. 提交變更
git commit -m "Add YouTube analytics tool"

# 6. 推送到 GitHub
git push origin main
```

### 步驟 4: 啟用 GitHub Pages
1. 在你的 repository 頁面，點擊上方的 **「Settings」**（設定）
2. 在左側選單找到 **「Pages」**
3. 在 **「Source」** 部分：
   - Branch: 選擇 **`main`**（或 `master`）
   - Folder: 選擇 **`/ (root)`**
4. 點擊 **「Save」**
5. 等待約 1-2 分鐘，頁面會顯示你的網站網址

### 步驟 5: 訪問你的網站
你的網站網址會是：
```
https://你的帳號名稱.github.io/youtube-influencer-analytics/
```

例如：
- 如果你的 GitHub 帳號是 `vgv-marketing`
- Repository 名稱是 `youtube-influencer-analytics`
- 網址就是：`https://vgv-marketing.github.io/youtube-influencer-analytics/`

## 📝 重要提醒

### ⚠️ 檔案命名
- 主頁面**必須**命名為 `index.html`
- GitHub Pages 會自動將 `index.html` 作為首頁

### 🔑 API Key 安全性
- **不要**將 YouTube API Key 直接寫在程式碼中
- 目前的工具設計是讓使用者自己輸入 API Key
- 這樣可以避免 API Key 被濫用

### 🔄 更新網站
如果要更新網站內容：
1. 修改 `index.html` 檔案
2. 上傳到 GitHub（覆蓋舊檔案）
3. 等待 1-2 分鐘，網站就會自動更新

## 🎨 進階設定（選擇性）

### 自訂網域名稱
如果你有自己的網域（例如 `analytics.vgv.com`）：
1. 在 repository 建立一個檔案叫 `CNAME`
2. 檔案內容只寫你的網域名稱：`analytics.vgv.com`
3. 在你的網域 DNS 設定中，新增 CNAME 記錄指向 `你的帳號名稱.github.io`

### 加入 README
建立一個 `README.md` 檔案來說明專案：
```markdown
# YouTube 影響力數據分析工具

VGV 圈粉行銷科技 - 專注影響力行銷

## 功能
- YouTube 排行榜（30/90/180天）
- 多國家支援
- 頻道數據分析
- 訂閱數、互動數據追蹤

## 使用方式
訪問：https://你的帳號名稱.github.io/youtube-influencer-analytics/

需要 YouTube Data API v3 金鑰才能使用。
```

## 🆘 常見問題

### Q: 網站顯示 404 錯誤
A: 檢查以下項目：
- 確認 GitHub Pages 已啟用
- 確認主檔案名稱是 `index.html`
- 等待 1-2 分鐘讓 GitHub 部署完成

### Q: 工具無法使用
A: 確認：
- 已正確輸入 YouTube API Key
- API Key 已啟用 YouTube Data API v3
- 瀏覽器主控台沒有錯誤訊息（按 F12 查看）

### Q: 想要私有部署
A: GitHub Pages 免費版只支援公開 repository。如需私有：
- 升級到 GitHub Pro（付費）
- 或使用其他託管服務（如 Netlify, Vercel）

## 📞 聯絡資訊
如有任何問題，歡迎聯繫 VGV 圈粉行銷科技團隊。

---

部署完成後，您就擁有一個專業的 YouTube 影響力數據分析工具了！🎉
