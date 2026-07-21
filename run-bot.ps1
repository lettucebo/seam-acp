# seam-acp 24/7 supervisor launcher.
#
# Run by the "seam-acp-bot" scheduled task at logon (see COPILOT-WINDOWS-SETUP.md).
# Keeps `node dist/index.js` running: restarts it on any exit with capped
# exponential backoff, appends all output to data/bot.log (rolled at 10MB), and
# pins the environment so it doesn't depend on the task's PATH quirks.
#
# Single instance is enforced by the app itself: the health port (HEALTH_PORT,
# default 3000) is a bind guard — a second instance exits cleanly on EADDRINUSE.
#
# To stop: run stop-bot.ps1 (or Disable-ScheduledTask + Stop-ScheduledTask).

Set-Location -Path $PSScriptRoot
$log = Join-Path $PSScriptRoot "data\bot.log"
$logOld = Join-Path $PSScriptRoot "data\bot.log.1"

# Copilot CLI auth lives under the user profile; the copilot profile resolves it
# via $HOME, which Windows does not set by default.
if (-not $env:HOME) { $env:HOME = $env:USERPROFILE }

# Pin absolute binaries (don't rely on the scheduled-task PATH).
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = "C:\nvm4w\nodejs\node.exe" }
$copilot = (Get-Command copilot -ErrorAction SilentlyContinue).Source
if ($copilot) { $env:COPILOT_CLI_PATH = $copilot }

$backoff = 5
while ($true) {
  # Roll the log between runs (handle is closed here), best-effort.
  try {
    if ((Test-Path $log) -and ((Get-Item $log).Length -gt 10MB)) {
      Move-Item -Force -Path $log -Destination $logOld
    }
  } catch { }

  "==== [$((Get-Date).ToString('s'))] launching: $node dist\index.js (HOME=$env:HOME) ====" >> $log
  if (-not (Test-Path $node)) {
    "ERROR: node not found ($node); retrying in 30s" >> $log
    Start-Sleep -Seconds 30
    continue
  }

  $start = Get-Date
  & $node "dist\index.js" *>> $log
  $code = $LASTEXITCODE
  $ranSec = [int]((Get-Date) - $start).TotalSeconds

  # Reset backoff after a stable run; otherwise grow (capped) to avoid a tight
  # crash loop hammering restart.
  if ($ranSec -gt 60) { $backoff = 5 } else { $backoff = [Math]::Min($backoff * 2, 60) }
  "==== [$((Get-Date).ToString('s'))] exited code=$code after ${ranSec}s; restarting in ${backoff}s ====" >> $log
  Start-Sleep -Seconds $backoff
}
