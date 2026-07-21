# Stop the seam-acp 24/7 bot cleanly.
#
# 1. Disable the task so it can't relaunch, then stop it (ends the task's
#    powershell+node process tree).
# 2. Kill any leftover `node dist/index.js` by PID (matched on command line).
#
# SAFETY: we NEVER kill by process name "copilot" — the copilot CLI children exit
# on their own when the bot's stdin closes, and a name-based kill could terminate
# an unrelated (or the currently-running) Copilot CLI. Only the bot's node PID is
# stopped here.
#
# To start again: Enable-ScheduledTask -TaskName seam-acp-bot; Start-ScheduledTask -TaskName seam-acp-bot

$task = "seam-acp-bot"

try { Disable-ScheduledTask -TaskName $task -ErrorAction Stop | Out-Null; Write-Host "disabled task $task" }
catch { Write-Host "task $task not found or already disabled: $($_.Exception.Message)" }

try { Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue | Out-Null; Write-Host "stopped task $task" } catch { }

Start-Sleep -Seconds 2

# Stop any surviving bot node process by command line (never by name).
$bot = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*dist*index.js*' }
foreach ($p in $bot) {
  try { Stop-Process -Id $p.ProcessId -Force; Write-Host "stopped bot node PID $($p.ProcessId)" }
  catch { Write-Host "could not stop PID $($p.ProcessId): $($_.Exception.Message)" }
}
if (-not $bot) { Write-Host "no bot node process running" }
Write-Host "done. (copilot children exit on their own once the bot stdin closes.)"
