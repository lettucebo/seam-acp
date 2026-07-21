# 從 Discord 控制 GitHub Copilot CLI（Windows）— 設定與交接

本 fork 在 `jbulpitt/seam-acp` 之上，讓你可以**從 Discord（含手機）以「一個 thread = 一個 Copilot session」的方式控制 GitHub Copilot CLI**，並把 Copilot 的互動選擇與規劃搬到 Discord 上操作。

> 工作分支已合併到 `main`（上游 `main` 在 Node 26 / Windows 下**無法建置**，本 fork 已修好）。上游同步用 `upstream-sync` 分支。

## 本 fork 相對上游的變更

| 變更 | 說明 | 狀態 |
|---|---|---|
| **可建置** | `better-sqlite3` 升 `^12`（Node 26 預編譯）、修正 `AgentProfile.spawn` 型別 | ✅ |
| **只載入已安裝的 agent** | agent profile 只在其 CLI 存在於 PATH 時才註冊（修 `spawn agy ENOENT` 啟動崩潰；此機只有 Copilot） | ✅ |
| **`/seam mode` 重啟安全** | 首回合前 / 重啟後重新套用持久化 mode；支援 `autopilot`/`plan`/`agent` 友善名稱；誠實回報 | ✅ 實測 autopilot 切換 |
| **`ask_user` 互動選擇** | Copilot 的 `ask_user` 不走 ACP；注入 `ask_user` MCP 工具，模型呼叫時把「問題＋2–25 選項」丟到 Discord 變按鈕/選單，回傳你的選擇 | ✅ 上線運行 |
| **Plan 模式呈現** | 顯示 ACP 計畫清單（⬜/✅）；plan 回合結束跳「執行方式」選單（**永不逾時**）；完整計畫兩種呈現並存（見下） | ✅ 上線運行 |
| **狀態卡片 Mode 欄位** | Working/Done 卡片顯示目前模式（Plan/Agent/Autopilot），即時更新 | ✅ |
| **鎖定頻道** | `DISCORD_ALLOWED_CHANNEL_IDS` 限制 bot 只在指定頻道/thread 回應 | ✅ |

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
4. **OAuth2 → URL Generator**：scope 勾 `bot` + `applications.commands`；Bot 權限勾 **View Channels、Send Messages、Send Messages in Threads**、Embed Links、Attach Files、Read Message History、Add Reactions、Create Public Threads、Manage Messages。（`Send Messages` 不含在 thread 內發言，務必勾 **Send Messages in Threads**。）
5. 用產生的 URL 邀請 bot 進**你也在**的伺服器（建議私人伺服器）。
6. 開啟 Discord 開發者模式，右鍵你的頭像 → Copy User ID（給 `DISCORD_ALLOWED_USER_IDS`）。

## 設定 `.env`

```dotenv
DISCORD_BOT_TOKEN=你的_bot_token
DISCORD_ALLOWED_USER_IDS=你的_discord_user_id     # 只有你能操控（重要安全邊界）
DISCORD_DEV_GUILD_ID=你的_guild_id                # slash 指令即時註冊（否則全域約 1 小時）
DISCORD_ALLOWED_CHANNEL_IDS=你的頻道_id           # 只在此頻道(及其 thread)回應；擋掉其他 bot 的頻道
DISCORD_COMMAND_NAME=seam                         # 指令名（/seam）。可改成 copilot / scout 等，不同實例不同名

REPOS_ROOT=C:\Source\Repos                        # 允許 agent 操作的 repo 根目錄（Windows 路徑）
DATA_DIR=./data

DEFAULT_AGENT=copilot
DEFAULT_MODEL=auto                                # 或 gpt-5.4 / claude-sonnet-4.5 ...

# 你習慣 yolo：工具權限全自動放行（ask_user 的「選擇」與此無關，仍會照常在 Discord 出選單）
DEFAULT_PERMISSION_POLICY=always

# 完整計畫呈現：true=每次規劃自動貼 plan.md 檔案卡片；false=只在選單點「顯示完整執行計畫」才貼。
# 兩種機制可並存（選單按鈕永遠都在）。
PLAN_FULL_AUTO=true
```

> `ask_user` 互動選擇**預設自動啟用**（每個 Copilot session 都會注入），不需額外環境變數。`ChoiceBroker` 只綁 `127.0.0.1`，每個 session 一組隨機 bearer token。
>
> **其他 bot 也在同頻道？** `DISCORD_ALLOWED_CHANNEL_IDS` 只約束**本 bot**。要擋掉別的 bot（例如 HermesAgent），到該 Discord 頻道 → 編輯頻道 → 權限 → 加入那個 bot → 拒絕「檢視頻道」。

## 執行

```powershell
cd C:\Source\Repos\seam-acp
npm install        # 首次
npm run build
npm start          # = node dist/index.js
```

在 Discord 允許的頻道：`/seam new` 開一個 thread → 選 repo → 直接在 thread 打字對話。
- `/seam mode plan|agent|autopilot`：切換模式（狀態卡片的 **Mode** 欄位會即時反映）。
- `/seam model <id>`、`/seam agent`、`/seam abort`、`/seam reset`、`/seam sessions`…（見 README）。
- 當模型需要你做選擇時，會在 thread 出**按鈕/下拉選單**，點一下即可（僅 `DISCORD_ALLOWED_USER_IDS` 內的你可點）。

### Plan 模式流程

`/seam mode plan` 後送規劃需求，回合結束時你會看到：
1. **📋 計畫清單**（ACP 待辦，⬜/✅ 進度）+ Copilot 的文字摘要。
2. **完整計畫**（兩機制並存）：
   - `PLAN_FULL_AUTO=true` → 自動附上 **plan.md 檔案卡片**（可展開/收合）。
   - 選單裡的 **📖 顯示完整執行計畫** → 直接把完整計畫以 render 過的 markdown 印在 thread（外層 ```` ```markdown ```` 包裝會自動拆掉，內層 ```` ```powershell ```` 正確渲染）。
3. **「接下來怎麼進行？」選單**（**永不逾時**）：📖 顯示完整執行計畫 / 🚀 切 Autopilot 執行 / 🤖 用 Agent 逐步執行 / ✋ 保持 Plan。點 🚀 或 🤖 會切換模式並自動送出「開始執行」。

### 24/7 常駐（Windows）— 已設定 ✅

以 **工作排程器（登入觸發）** 常駐，**不是 Windows 服務**——因為 Copilot CLI 憑證綁使用者設定檔（`~/.copilot`），服務跑在 session 0 拿不到；登入任務跑在你的 session 才能 spawn `copilot`。

- **任務**：`seam-acp-bot`（AtLogOn / 使用者 `FAREAST\tzyu` / 互動式 / 免系統管理員）。
- **啟動器 `run-bot.ps1`**：迴圈跑 `node dist/index.js`，任何退出都自動重啟（capped backoff，穩定執行後 reset），輸出附加到 `data/bot.log`（>10MB 自動滾成 `bot.log.1`）；設 `HOME=%USERPROFILE%`、絕對 node 路徑、`COPILOT_CLI_PATH`。
- **單一實例守衛**：health port（`HEALTH_PORT`，預設 3000）被佔用時第二個實例會乾淨退出（不會搶登入）。
- **重啟/部署**：`npm run redeploy`（build → 寫 `data/.restart-pending` → bot 排空後**優雅退出** → 迴圈relaunch 新版）。**勿**直接 kill node / `Stop-ScheduledTask` 來重啟。
- **停止（少用）**：`.\stop-bot.ps1`（停用任務 + 停 node PID；不以名稱殺 `copilot`）。重新啟用：`Enable-ScheduledTask -TaskName seam-acp-bot; Start-ScheduledTask -TaskName seam-acp-bot`。
- **狀態/日誌**：`Get-ScheduledTask seam-acp-bot`、`Get-Content .\data\bot.log -Tail 100`、`curl http://localhost:3000/health`。
- **睡眠**（未自動更改，opt-in）：真 24/7 需機器不睡 → `powercfg /change standby-timeout-ac 0`（並視需要關 hibernate）。
- **限制**：需該使用者**保持登入**；登出、開機到登入前、睡眠/休眠/闔蓋期間為中斷。
- 註冊指令（一次性）：
  ```powershell
  $repo="C:\Source\Repos\seam-acp"; $ps="$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $a=New-ScheduledTaskAction -Execute $ps -Argument "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$repo\run-bot.ps1`"" -WorkingDirectory $repo
  $t=New-ScheduledTaskTrigger -AtLogOn -User "FAREAST\tzyu"
  $p=New-ScheduledTaskPrincipal -UserId "FAREAST\tzyu" -LogonType Interactive -RunLevel Limited
  $s=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName "seam-acp-bot" -Action $a -Trigger $t -Principal $p -Settings $s -Force
  ```

> `npm start`（上面「執行」段）僅供**手動/開發**測試；正式常駐一律用上面的任務。兩者勿同時跑（health port 會擋第二個）。

## 已知限制 / 待辦

- **`ask_user` 是「盡力」機制**：Copilot 的原生 `ask_user` 不走 ACP，我們靠注入的 MCP 工具重現。模型「大多」會呼叫它（工具描述已強力指示），但仍可能改用純文字提問——此時直接在 thread 用文字回覆即可。
- **只支援選項、無 free-text**：`ask_user` 一律要 **2–25 個明確選項**（是非題請用 `["Yes","No"]`）；沒有「自行輸入」欄位。開放式（無固定選項）問題模型會改用純文字提問。
- **取消時 Discord 選單不會立即消失**：`/seam cancel` 或程式重啟時，已張貼的 `ask_user` 選單會保留到自身逾時才失效（plan「執行方式」選單則刻意永不逾時）。
- **多 thread 併發寫同一 repo**：請不同 thread 綁不同 repo/worktree，避免 git index 衝突。session 路由本身是隔離的（每 thread 各自 runtime / ask_user token / plan.md / mode）。

> 首次測試建議設 `DISCORD_DEV_GUILD_ID`（你的伺服器 ID），slash 指令會即時註冊；否則全域註冊可能要等約一小時才生效。

## 安全

Discord = 以你的 Windows 身分執行任意指令（尤其 `DEFAULT_PERMISSION_POLICY=always`）。務必：私人伺服器/頻道、嚴格 `DISCORD_ALLOWED_USER_IDS`、Discord 開 2FA、token 不進版控（`.env` 已 gitignore）；理想上用**專用非 admin Windows 帳號或 VM**、NTFS 僅授權指定 repo。
