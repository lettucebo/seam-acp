#Requires -Version 5.1
<#
  seam-acp installer for Windows.

  Thin native bootstrapper: checks/installs prerequisites (Node >= 22, git, gh,
  GitHub Copilot CLI via winget), hands off to the shared tested core
  (scripts/setup.mjs) for config + build, then optionally registers 24/7
  residency (the seam-acp-bot scheduled task, reusing run-bot.ps1).

  Run from a normal (non-admin) PowerShell, from inside the cloned repo:
    powershell -ExecutionPolicy Bypass -File .\install.ps1

  Flags: -Yes  -DryRun  -Residency  -NoResidency  -SkipAuth
#>
[CmdletBinding()]
param(
  [switch]$Yes,
  [switch]$DryRun,
  [switch]$Residency,
  [switch]$NoResidency,
  [switch]$SkipAuth
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$RepoRoot = $PSScriptRoot

# --- output -----------------------------------------------------------------
$UseColor = (-not $env:NO_COLOR) -and (-not [Console]::IsOutputRedirected)
function Section($m) { if ($UseColor) { Write-Host "`n> $m" -ForegroundColor Cyan } else { Write-Host "`n> $m" } }
function Okay($m)    { if ($UseColor) { Write-Host "OK  $m" -ForegroundColor Green } else { Write-Host "OK  $m" } }
function Note($m)    { if ($UseColor) { Write-Host "!   $m" -ForegroundColor Yellow } else { Write-Host "!   $m" } }
function Bad($m)     { if ($UseColor) { Write-Host "X   $m" -ForegroundColor Red } else { Write-Host "X   $m" } }
function Die($m)     { Bad $m; exit 1 }

# --- package manager --------------------------------------------------------
$PM = if (Get-Command winget -ErrorAction SilentlyContinue) { "winget" }
      elseif (Get-Command choco -ErrorAction SilentlyContinue) { "choco" }
      else { $null }

function RefreshSessionPath {
  $m = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $u = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = (@($m, $u) | Where-Object { $_ }) -join ";"
}

function Install-Pkg($WingetId, $ChocoId) {
  if ($PM -eq "winget") {
    winget install -e --id $WingetId --accept-source-agreements --accept-package-agreements --silent
  } elseif ($PM -eq "choco") {
    choco install $ChocoId -y
  } else {
    throw "no supported package manager (winget/choco) found"
  }
}

function Get-NodeMajor {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return 0 }
  try { return [int](& node -p "process.versions.node.split('.')[0]" 2>$null) } catch { return 0 }
}

function Install-NodeMin {
  if ((Get-NodeMajor) -ge 22) { Okay "node $(& node -v)"; return }
  Section "Installing Node >= 22"
  if ($DryRun) { Note "dry-run: would install Node LTS via $PM"; return }
  if (-not $PM) { Die "no winget/choco; install Node >= 22 manually and re-run" }
  Install-Pkg "OpenJS.NodeJS.LTS" "nodejs-lts"
  RefreshSessionPath
  if ((Get-NodeMajor) -lt 22) { Die "Node still < 22 - open a NEW terminal and re-run (PATH not refreshed in this session)" }
  Okay "node $(& node -v)"
}

function Install-Tool($Cmd, $WingetId, $ChocoId) {
  if (Get-Command $Cmd -ErrorAction SilentlyContinue) { Okay "$Cmd present"; return }
  Section "Installing $Cmd"
  if ($DryRun) { Note "dry-run: would install $WingetId via $PM"; return }
  if (-not $PM) { Note "no package manager; install '$Cmd' manually"; return }
  Install-Pkg $WingetId $ChocoId
  RefreshSessionPath
  if (-not (Get-Command $Cmd -ErrorAction SilentlyContinue)) { Die "$Cmd still not found - open a new terminal and re-run" }
  Okay "$Cmd installed"
}

function Install-Copilot {
  if (Get-Command copilot -ErrorAction SilentlyContinue) { Okay "copilot present"; return }
  Section "Installing GitHub Copilot CLI"
  if ($DryRun) { Note "dry-run: would 'winget install GitHub.Copilot'"; return }
  if ($PM -eq "winget") {
    # winget gives a real copilot.exe. The app spawns without a shell, so it
    # CANNOT use the npm .cmd shim - prefer winget on Windows.
    winget install -e --id GitHub.Copilot --accept-source-agreements --accept-package-agreements --silent
  } else {
    Note "winget not available. Install Copilot CLI so it provides a real copilot.exe (npm's .cmd shim will NOT work with the app's shell-less spawn)."
    return
  }
  RefreshSessionPath
  if (Get-Command copilot -ErrorAction SilentlyContinue) { Okay "copilot installed" }
  else { Note "copilot not on PATH yet - open a new terminal, then run: copilot login" }
}

# --- residency (reuse run-bot.ps1 + fixed task name) ------------------------
function Get-EnvValue($Key) {
  $envFile = Join-Path $RepoRoot ".env"
  if (-not (Test-Path $envFile)) { return $null }
  $line = Select-String -Path $envFile -Pattern "^$Key=" | Select-Object -Last 1
  if (-not $line) { return $null }
  return (($line.Line -split "=", 2)[1]).Trim().Trim('"').Trim("'")
}

function Register-Residency {
  $task = "seam-acp-bot"
  $ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $runbot = Join-Path $RepoRoot "run-bot.ps1"
  New-Item -ItemType Directory -Force -Path (Join-Path $RepoRoot "data") | Out-Null

  if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) {
    Note "scheduled task '$task' exists; re-registering to point at this repo"
  }
  $arg = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runbot`""
  $a = New-ScheduledTaskAction -Execute $ps -Argument $arg -WorkingDirectory $RepoRoot
  $t = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $p = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  $s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $task -Action $a -Trigger $t -Principal $p -Settings $s -Force | Out-Null
  Start-ScheduledTask -TaskName $task
  Okay "registered + started scheduled task: $task"
}

function Test-Readiness($LogBefore) {
  $port = Get-EnvValue "HEALTH_PORT"; if (-not $port) { $port = "3000" }
  $log = Join-Path $RepoRoot "data\bot.log"
  Section "Readiness check"
  $found = $false
  for ($i = 0; $i -lt 25; $i++) {
    if (Test-Path $log) {
      $lines = @(Get-Content $log -ErrorAction SilentlyContinue)
      if ($lines.Count -gt $LogBefore) {
        $new = $lines[$LogBefore..($lines.Count - 1)] -join "`n"
        if ($new -match "seam-acp ready") { Okay "new process logged 'seam-acp ready'"; $found = $true; break }
      }
    }
    Start-Sleep -Seconds 1
  }
  if (-not $found) { Note "did not observe a fresh 'seam-acp ready' within 25s - check $log" }
  try {
    Invoke-WebRequest -UseBasicParsing "http://localhost:$port/health" -TimeoutSec 5 | Out-Null
    Okay "/health responding on port $port"
  } catch {
    Note "/health not responding on port $port yet"
  }
  Note "Manual final check: send a message to your bot in Discord to confirm an end-to-end Copilot turn."
}

# --- run --------------------------------------------------------------------
Write-Host "seam-acp installer - Windows"
if ($DryRun) { Note "dry-run: no changes will be made" }
if (-not $PM) { Note "no winget/choco detected; prerequisite auto-install is limited" }

Section "Prerequisites"
Install-NodeMin
Install-Tool "git" "Git.Git" "git"
Install-Tool "gh" "GitHub.cli" "gh"
Install-Copilot

Section "Configuration & build (shared core)"
$setupArgs = @()
if ($Yes) { $setupArgs += "--yes" }
if ($DryRun) { $setupArgs += "--dry-run" }
if ($SkipAuth) { $setupArgs += "--skip-auth" }
& node (Join-Path $RepoRoot "scripts\setup.mjs") @setupArgs
if ($LASTEXITCODE -ne 0) { Die "setup.mjs failed (exit $LASTEXITCODE)" }

if ($DryRun) {
  Section "Residency"
  Note "dry-run: would offer to register the seam-acp-bot scheduled task here"
  Okay "dry-run complete"
  return
}

# Decide residency.
$doResidency = $false
if ($Residency) { $doResidency = $true }
elseif ($NoResidency) { $doResidency = $false }
elseif (-not ($Yes -or [Console]::IsInputRedirected)) {
  $ans = Read-Host "Set up 24/7 residency (auto-start at logon + restart on crash)? (y/N)"
  $doResidency = ($ans -match "^(y|yes)$")
}

if ($doResidency) {
  Section "24/7 residency"
  $logBefore = 0
  $logPath = Join-Path $RepoRoot "data\bot.log"
  if (Test-Path $logPath) { $logBefore = @(Get-Content $logPath -ErrorAction SilentlyContinue).Count }
  Register-Residency
  Test-Readiness $logBefore
} else {
  Section "Residency skipped"
  Okay "Start the bot manually with: npm start   (or re-run with -Residency to auto-start)"
}

Section "Done"
Okay "seam-acp is set up."
Write-Host "Stop residency: .\stop-bot.ps1   Logs: Get-Content .\data\bot.log -Tail 40 -Wait"
