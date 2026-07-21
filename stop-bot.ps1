# Stop the seam-acp 24/7 bot cleanly.
#
# 1. Disable the task so it can't relaunch, then stop it (ends the task's
#    powershell+node process tree).
# 2. Capture the bot node PID(s) — matched on the ABSOLUTE dist\index.js path so
#    it can't hit an unrelated node app — and their descendant PIDs FIRST (a
#    detached copilot child is reparented/orphaned once node dies, so it must be
#    enumerated before the kill).
# 3. Kill the bot node by PID, then clean up any of THOSE captured copilot
#    descendants that survive — by PID.
#
# SAFETY: we NEVER kill by process name "copilot". The copilot CLI children exit
# on their own when the bot's stdin closes; only lineage-verified descendant PIDs
# of THIS bot's node are stopped. A name-based kill could terminate an unrelated
# (or the currently-running) Copilot CLI.
#
# To start again: Enable-ScheduledTask -TaskName seam-acp-bot; Start-ScheduledTask -TaskName seam-acp-bot

$task = "seam-acp-bot"

try { Disable-ScheduledTask -TaskName $task -ErrorAction Stop | Out-Null; Write-Host "disabled task $task" }
catch { Write-Host "task $task not found or already disabled: $($_.Exception.Message)" }

try { Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue | Out-Null; Write-Host "stopped task $task" } catch { }

Start-Sleep -Seconds 2

# Stop any surviving bot node process (never by name). Enumerate descendants
# before killing, because a detached copilot child is orphaned once node exits.
$script = Join-Path $PSScriptRoot "dist\index.js"

function Get-Descendants($rootPid) {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name
  $found = @{}
  $stack = New-Object System.Collections.Stack
  $stack.Push($rootPid)
  while ($stack.Count -gt 0) {
    $cur = $stack.Pop()
    foreach ($c in ($all | Where-Object { $_.ParentProcessId -eq $cur })) {
      if (-not $found.ContainsKey([int]$c.ProcessId)) {
        $found[[int]$c.ProcessId] = $c
        $stack.Push($c.ProcessId)
      }
    }
  }
  return $found.Values
}

$bot = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($script.ToLower()) }

$descendants = @()
foreach ($n in $bot) { $descendants += Get-Descendants $n.ProcessId }

foreach ($p in $bot) {
  try { Stop-Process -Id $p.ProcessId -Force; Write-Host "stopped bot node PID $($p.ProcessId)" }
  catch { Write-Host "could not stop PID $($p.ProcessId): $($_.Exception.Message)" }
}
if (-not $bot) { Write-Host "no bot node process running" }

Start-Sleep -Seconds 2

# Clean up ONLY captured copilot descendants that survived stdin-close — by PID.
foreach ($d in $descendants) {
  if ($d.Name -ne 'copilot.exe') { continue }
  if (Get-Process -Id $d.ProcessId -ErrorAction SilentlyContinue) {
    try { Stop-Process -Id $d.ProcessId -Force; Write-Host "stopped orphaned copilot descendant PID $($d.ProcessId)" }
    catch { Write-Host "could not stop copilot PID $($d.ProcessId): $($_.Exception.Message)" }
  }
}
Write-Host "done."
