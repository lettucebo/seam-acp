# 從 Discord 控制 GitHub Copilot CLI（Windows）— 設定與交接

本 fork 在 `jbulpitt/seam-acp` 之上，讓你可以**從 Discord（含手機）以「一個 thread = 一個 Copilot session」的方式控制 GitHub Copilot CLI**，並把 Copilot 的互動選擇搬到 Discord 上點選。

> 分支：`feat/copilot-discord-windows`。上游 `main` 在 Node 26 / Windows 下**無法建置**，本 fork 已修好。

## 本 fork 相對上游的變更

| 變更 | 說明 | 驗證狀態 |
|---|---|---|
| **可建置** | `better-sqlite3` 升 `^12`（Node 26 預編譯）、修正 `AgentProfile.spawn` 型別 | ✅ `tsc` 乾淨、`npm run build` 成功 |
| **`/seam mode` 重啟安全** | 首回合前 / 重啟後會重新套用持久化的 mode；支援 `autopilot`/`plan`/`agent` 友善名稱；誠實回報成功/失敗 | ✅ 以真實 ACP 驗證 `session/set_mode` 由 agent 切到 autopilot |
| **`ask_user` 互動選擇** | Copilot 的 `ask_user` 不走 ACP；本 fork 注入一個 `ask_user` MCP 工具，模型呼叫時把「問題＋選項」丟到 Discord 變按鈕/選單，回傳你的選擇 | ✅ 伺服器側迴路（模型→MCP→broker→回答→模型）以編譯後 dist 驗證；⏳ Discord 端來回需 bot token 才能實測 |

架構：
```
Discord(手機/桌面) ──gateway──> seam-acp(Node) ──ACP stdio──> copilot --acp  (一 thread 一進程)
                                    │  thread<->sessionId (SQLite)                │ --additional-mcp-config 注入
                                    │  ChoiceBroker(loopback 127.0.0.1 + bearer)  ▼
                                    └────────── 呈現按鈕/選單 ◄── ask_user MCP ──呼叫
```

## 前置需求

1. **付費 Copilot 訂閱**（Pro / Pro+ / Business / Enterprise）。**Free 版不支援 CLI/ACP**。Business/Enterprise 需管理者於 Policies 啟用 Copilot CLI。
2. **Copilot CLI 已登入**：`copilot`（本機為 WinGet 的 `copilot.exe`），執行過 `copilot login`。
3. **Node 18+**（本機為 Node 26，OK）。
4. **Discord bot**（見下）。

## 建立 Discord Bot（只有你能做）

1. 前往 <https://discord.com/developers/applications> → **New Application**。
2. 左側 **Bot** → **Reset Token** → 複製 token（只顯示一次）。
3. **Privileged Gateway Intents** 開啟 **MESSAGE CONTENT INTENT**。
4. **OAuth2 → URL Generator**：scope 勾 `bot` + `applications.commands`；Bot 權限勾 Send Messages、Embed Links、Attach Files、Read Message History、Add Reactions、Create Public Threads、Manage Messages。
5. 用產生的 URL 邀請 bot 進**你也在**的伺服器（建議私人伺服器）。
6. 開啟 Discord 開發者模式，右鍵你的頭像 → Copy User ID（給 `DISCORD_ALLOWED_USER_IDS`）。

## 設定 `.env`

```dotenv
DISCORD_BOT_TOKEN=你的_bot_token
DISCORD_ALLOWED_USER_IDS=你的_discord_user_id     # 只有你能操控（重要安全邊界）
# DISCORD_DEV_GUILD_ID=你的_guild_id              # 開發時 slash 指令即時註冊

REPOS_ROOT=C:\Source\Repos                        # 允許 agent 操作的 repo 根目錄（Windows 路徑）
DATA_DIR=./data

DEFAULT_AGENT=copilot
DEFAULT_MODEL=gpt-5.4                              # 或 auto / claude-sonnet-4.5 ...

# 你習慣 yolo：工具權限全自動放行（ask_user 的「選擇」與此無關，仍會照常在 Discord 出選單）
DEFAULT_PERMISSION_POLICY=always
```

> `ask_user` 互動選擇**預設自動啟用**（每個 Copilot session 都會注入），不需額外環境變數。`ChoiceBroker` 只綁 `127.0.0.1`，每個 session 一組隨機 bearer token。

## 執行

```powershell
cd C:\Source\Repos\seam-acp
npm install        # 首次
npm run build
npm start          # = node dist/index.js
```

在 Discord 允許的頻道：`/seam new` 開一個 thread → 選 repo → 直接在 thread 打字對話。
- `/seam mode autopilot`：切到自動執行模式（規劃完要放手時用）。
- `/seam model <id>`、`/seam agent`、`/seam abort`、`/seam reset`、`/seam sessions`…（見 README）。
- 當模型需要你做選擇時，會在 thread 出**按鈕/下拉選單**，點一下即可（僅 `DISCORD_ALLOWED_USER_IDS` 內的你可點）。

### 24/7 常駐（Windows）

`pm2 startup` 在 Windows **不原生支援**。建議用**工作排程器**（登入時啟動、失敗自動重啟）或 [WinSW](https://github.com/winsw/winsw) 包成服務，以「擁有 Copilot 憑證的同一使用者」執行，並停用睡眠。

## 已知限制 / 待辦

- **`ask_user` 是「盡力」機制**：Copilot 的原生 `ask_user` 不走 ACP，我們靠注入的 MCP 工具重現。模型「大多」會呼叫它（工具描述已強力指示），但仍可能改用純文字提問——此時直接在 thread 用文字回覆即可。
- **「自行輸入」尚未做**：目前選單只支援點選項（buttons/select）。「Or type your own answer」需要 Discord modal，列為後續（需 token 邊做邊驗）。若模型呼叫 `ask_user` 但沒給選項，presenter 會請模型改用文字提問。
- **Discord 端來回尚未實測**：伺服器側迴路已驗證；`adapter.sendChoicePicker`（貼按鈕、等點選）沿用專案既有、已被其他指令使用的原語，但整條 Discord 來回需 bot token 才能端到端驗證。
- **多 thread 併發寫同一 repo**：請不同 thread 綁不同 repo/worktree，避免 git index 衝突。

## 安全

Discord = 以你的 Windows 身分執行任意指令（尤其 `DEFAULT_PERMISSION_POLICY=always`）。務必：私人伺服器/頻道、嚴格 `DISCORD_ALLOWED_USER_IDS`、Discord 開 2FA、token 不進版控（`.env` 已 gitignore）；理想上用**專用非 admin Windows 帳號或 VM**、NTFS 僅授權指定 repo。
