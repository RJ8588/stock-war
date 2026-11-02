# stock-war

## 資料保存與 GitHub 更新

- 程式碼可以透過 GitHub 更新；持倉、交易、入金、比例設定等使用者資料存放在 Replit PostgreSQL 的 `dashboard_state` 資料列，不放進 GitHub。
- Replit 正式環境需提供 `DATABASE_URL`。若正式環境是 Replit、但沒有設定資料庫連線，伺服器會停止啟動，避免靜默退回可能隨重新部署消失的本機檔案。
- 本機開發及未設定資料庫的非正式環境仍使用 `.data/dashboard-state.json`；此資料夾已加入 `.gitignore`，請勿移除忽略規則或提交其中的資料。
- GitHub.dev / Codespaces 預覽必須以 `HOST=0.0.0.0` 綁定，避免 `127.0.0.1` 只允許本機存取。啟動腳本已修正為固定在 `PORT=4173`、`HOST=0.0.0.0`。
- Codespaces 啟動時，`.devcontainer/devcontainer.json` 會自動執行 `postStartCommand`，因此每次開啟容器都會自動檢查並啟動 `node server.js`。
- 第一次連接資料庫時，伺服器會優先沿用現存的 `.data/dashboard-state.json`。若該檔案不存在，瀏覽器仍會從原有 `localStorage` 載入資料，並在啟動後同步至資料庫。

### Replit 正式環境一次性設定

1. 在 Replit 為這個 App 建立／選擇 PostgreSQL Database，並確認正式部署有自己的 Production database 與 `DATABASE_URL`。
2. 重新部署前，確認部署使用的是原有 Production database；不要用空白的開發資料庫覆蓋正式資料。
3. 之後只要從 GitHub 更新程式碼並重新部署，程式會繼續讀寫同一個資料庫。

資料庫連線資訊只放在 Replit Secrets／部署環境變數，不要寫進程式碼或提交到 GitHub。
