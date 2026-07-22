# 安裝指南（Windows / macOS / Linux）

引導式安裝器會：檢查並（經同意）安裝前置需求 → 互動式收集設定寫入 `.env` →
`npm ci` 建置 → （可選）設定 24/7 常駐。所有平台共用同一份設定引擎
（`scripts/setup.mjs`），行為一致。

> 先決條件：**推薦用下面的一行網路安裝**（會自動 clone，不需手動先 clone）。
> 若你偏好手動，也可先 clone 再在 **repo 根目錄**執行 `install.sh` / `install.ps1`。

---

## 一行網路安裝（推薦，免手動 clone）

複製一行即可；它會問你要裝到哪、自動 clone、再執行安裝器。

**macOS / Linux**（用命令替換形式，保留互動輸入；**別用** `curl | bash` 管道，會無法輸入 token）
```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/lettucebo/seam-acp/main/get.sh)"
```

**Windows（PowerShell）**
```powershell
irm https://raw.githubusercontent.com/lettucebo/seam-acp/main/get.ps1 | iex
```

- **目標資料夾**：預設 `~/seam-acp`（Windows：`%USERPROFILE%\seam-acp`），會互動詢問可 Enter 沿用；或用環境變數 `SEAM_ACP_DIR` 指定、`SEAM_ACP_REF` 選分支/tag（預設 `main`）。
- **傳旗標**：bash `bash -c "$(curl -fsSL .../get.sh)" _ --yes`（`_` 佔位 `$0`，旗標才會落在 `$@`）；PowerShell `& ([scriptblock]::Create((irm .../get.ps1))) -Yes`。
- **既有資料夾**：若目標已是同一個 seam-acp checkout → 直接沿用（不自動 `git pull`，要更新請自己 `git -C <dir> pull`）；若非空且非本 repo → 中止並請你換 `SEAM_ACP_DIR`。
- **安全**：全程 https、來源是本 repo。想先看內容再跑：`curl -fsSL .../get.sh | less`（PowerShell：`irm .../get.ps1`）檢視後再執行。
- **Git 尚未安裝也沒關係**：bootstrap 會先幫你裝 git（Windows 需 winget/choco；mac 需 Homebrew）再 clone。

---

## （替代）手動 clone 再安裝

**macOS / Linux**
```sh
git clone https://github.com/lettucebo/seam-acp.git
cd seam-acp
./install.sh
```

**Windows**（一般、非系統管理員的 PowerShell）
```powershell
git clone https://github.com/lettucebo/seam-acp.git
cd seam-acp
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

> Windows 若連 git 都還沒有：用上面的一行網路安裝（會自動裝 git），或先
> `winget install Git.Git` 再 clone。

---

## 安裝器做了什麼

1. **前置需求**：Node ≥ 22、git、gh(GitHub CLI)、GitHub Copilot CLI。缺的會經同意安裝：
   - Windows：`winget`（`OpenJS.NodeJS.LTS`、`Git.Git`、`GitHub.cli`、**`GitHub.Copilot`**）。
     Copilot 一定用 winget 的真 `copilot.exe`（app 以無 shell 的 `spawn` 執行，npm 的
     `.cmd` shim 無法被執行）。
   - macOS：`brew`（node、git、gh）＋ `npm i -g @github/copilot`。
   - Linux：`apt`/`dnf` 裝 git、gh；Node ≥ 22 用 **nvm**（使用者層級，避免 `sudo npm -g`）；
     Copilot 用 `npm i -g @github/copilot`。
   - 安裝後會**刷新 PATH 並重驗**；若當前終端仍找不到，會請你**重開終端再跑一次**（不會硬撐）。
2. **設定 → `.env`**：互動式逐項詢問（既有值為預設，Enter 沿用），token 隱藏輸入。
   以**資料**方式安全合併（保留註解、未知 key、順序、換行風格），原子寫入、權限 `600`，
   變更前備份成 `.env.<timestamp>.bak`（已 gitignore）。安裝過程 token 不回顯、不寫入命令列、
   不傳給安裝用的子行程（npm/套件管理器）；Windows 另以 `icacls` 盡力把 `.env` 及備份的權限
   限縮為本人。（註：bot 執行時本身會把環境變數傳給它 spawn 的 copilot 子行程，這屬 app 行為、非安裝器範圍。）
3. **建置**：全新安裝用 `npm ci`（有 lockfile），重跑則用 `npm install`（不清空 `node_modules`）＋ `npm run build`。
4. **認證檢查**（best-effort）：`gh auth status`、Copilot 設定；未認證會提示
   `gh auth login` / `copilot login`。`--skip-auth` 可略過（視為未驗證）。
5. **常駐（可選）**：見下。

### 會被詢問的設定
| 設定 | 必填 | 說明 |
|---|---|---|
| `DISCORD_BOT_TOKEN` | ✅ | Bot token（隱藏輸入）。 |
| `DISCORD_ALLOWED_USER_IDS` | ✅ | 允許控制 bot 的 Discord user ID（至少你自己；逗號分隔）。 |
| `DISCORD_COMMAND_NAME` | | 「名字」＝斜線指令名，如 `copilot` → `/copilot`（預設 `seam`）。 |
| `REPOS_ROOT` | ✅ | agent 可操作的 repo 根目錄（不存在會建立）。 |
| `DISCORD_ALLOWED_CHANNEL_IDS` | | 限制頻道；**`/repo clone｜new` 必需**。 |
| `DISCORD_DEV_GUILD_ID` | | 開發伺服器 ID，填了斜線指令即時註冊（建議）。 |
| `DEFAULT_MODEL` | | 預設模型（`auto`、`gpt-5.4`…）。 |
| `DEFAULT_PERMISSION_POLICY` | | `ask`（建議）/ `always`（yolo，會警告）/ `deny`。 |
| `HEALTH_PORT` | | 存活埠，預設 `3000`。 |

`COPILOT_CLI_PATH` 由安裝器自動解析為絕對路徑寫入（避免 dotenv `override` 以空值覆蓋啟動器）。

---

## 旗標

| 旗標（sh / ps1） | 作用 |
|---|---|
| `--yes` / `-Yes` | 非互動：沿用既有/預設值，不提問。缺必填且無 TTY → **先失敗並列出缺的 key**，不寫檔。 |
| `--residency` / `-Residency` | 直接設定 24/7 常駐（與 `--no-residency` 互斥）。 |
| `--no-residency` / `-NoResidency` | 跳過常駐。 |
| `--enable-linger`（僅 Linux） | 一併 `loginctl enable-linger`，登入前/登出後也常駐（可能需 sudo）。 |
| `--dry-run` / `-DryRun` | 只顯示將執行的動作，不變更、不建置、遮蔽密鑰。 |
| `--skip-auth` / `-SkipAuth` | 跳過 gh/copilot 認證檢查（視為未驗證）。 |

> 密鑰只經 `.env` 或環境變數提供，**絕不**用命令列參數（會出現在行程清單）。

---

## 24/7 常駐

安裝器會詢問是否設定常駐（預設否）。各平台機制：

### Windows — 工作排程器（登入觸發）
- 註冊固定名稱任務 `seam-acp-bot`（AtLogon / 互動式 / 免系統管理員），由 `run-bot.ps1`
  監督（崩潰自動重啟 + backoff + log 輪替）。
- **限制**：需該使用者保持登入；登出、開機到登入前、睡眠/休眠期間中斷。
- 停止：`.\stop-bot.ps1`（停用+停止任務，只依 PID 收尾，絕不以名稱殺 `copilot`）。
- 重啟/部署（改過程式碼後）：`npm run redeploy`（優雅排空後重啟）。

### macOS — launchd 使用者代理（實驗性，未於真機驗證）
- 產生 `~/Library/LaunchAgents/com.seam-acp.bot.plist`（`RunAtLoad`+`KeepAlive`，
  絕對路徑，log 到 `data/bot.log`），`plutil -lint` 驗證後 `launchctl bootstrap gui/$UID`。
- **限制**：LaunchAgent 僅**登入後**執行（非 pre-login）。可能需在系統設定的
  「登入項目/背景項目」允許。
- 停止：`./stop-bot.sh`（`launchctl bootout`）；`./stop-bot.sh --disable` 一併停用自動啟動。

### Linux — systemd `--user` 服務（實驗性，未於真機驗證）
- 產生 `~/.config/systemd/user/seam-acp-bot.service`（`Restart=always`，log append 到
  `data/bot.log`），`daemon-reload` 後 `systemctl --user enable --now`。
- **登入前/登出後常駐**需 linger：`sudo loginctl enable-linger $USER`（或裝時加 `--enable-linger`）。
- 狀態/日誌：`systemctl --user status seam-acp-bot`、`tail -f data/bot.log`。
- 停止：`./stop-bot.sh`（`systemctl --user stop`）；`./stop-bot.sh --disable` 一併停用。

> 若沒有可用的 systemd `--user`（部分容器/精簡系統），安裝器會略過常駐，改請你用
> `./run-bot.sh` 手動啟動。

---

## 安裝後的最後一步（手動）

安裝器的就緒檢查會確認新進程寫出 `seam-acp ready` 且 `/health` 有回應——但這只證明
**bot 上線**。請**到 Discord 送一則訊息給你的 bot**，確認端到端的 Copilot 回覆正常
（首次可能需要先 `copilot login`）。

---

## 解除安裝 / 停用

- 停止並停用常駐：
  - Windows：`.\stop-bot.ps1`，永久移除：`Unregister-ScheduledTask -TaskName seam-acp-bot -Confirm:$false`
  - macOS：`./stop-bot.sh --disable`，移除 `~/Library/LaunchAgents/com.seam-acp.bot.plist`
  - Linux：`./stop-bot.sh --disable`，移除 `~/.config/systemd/user/seam-acp-bot.service` 後
    `systemctl --user daemon-reload`；如當初開了 linger 且不再需要：`sudo loginctl disable-linger $USER`
- 設定與資料：刪 `.env`、`data/`（含 sqlite 與 log）即可。全域 CLI（copilot/gh/node）需自行移除。

---

## 疑難排解

- **裝完 node/copilot 後找不到指令**：PATH 未在當前終端生效 → 開新終端再跑一次安裝器。
- **Windows 執行原則擋住**：用 `powershell -ExecutionPolicy Bypass -File .\install.ps1`
  啟動即可（安裝器不會永久更改執行原則）。
- **Windows 上 Copilot turn 失敗**：確認 `copilot` 是 winget 的 `copilot.exe`
  （`where copilot`），不是 npm 的 `.cmd` shim；`.env` 的 `COPILOT_CLI_PATH` 應指向該 `.exe`。
- **`/repo clone｜new` 不能用**：需設 `DISCORD_ALLOWED_CHANNEL_IDS`，且 `gh auth status` 已登入。
- **HEALTH_PORT 被占用**：改 `.env` 的 `HEALTH_PORT` 到空閒埠（單一實例守衛會擋同埠第二個實例）。
- **Linux 沒有 systemd `--user`**：用 `./run-bot.sh` 手動啟動，或改用你的 init 系統。
- **重跑安裝器**：安裝器主要用於**首次安裝**。若 bot 正在常駐執行，重跑時 Windows 上 `npm ci` 可能因原生模組（better-sqlite3）被鎖而失敗——安裝器已改為偵測到 `node_modules` 時用 `npm install`（不清空）規避；純粹更新程式碼請用 `npm run redeploy`（優雅排空後重啟），不需重跑安裝器。macOS/Linux 重跑會重啟服務（短暫中斷）。
