#Requires -Version 5.1
<#
  seam-acp one-line network bootstrap (Windows).

  Run WITHOUT cloning first:
    irm https://raw.githubusercontent.com/lettucebo/seam-acp/main/get.ps1 | iex

  With flags (the pipe form can't pass args; use the scriptblock form):
    & ([scriptblock]::Create((irm https://raw.githubusercontent.com/lettucebo/seam-acp/main/get.ps1))) -Yes

  Env overrides:  SEAM_ACP_DIR (target dir), SEAM_ACP_REF (branch/tag, default main)

  Ensures git, clones the repo, then hands off to the repo's install.ps1 in a
  CHILD process (isolated session + ExecutionPolicy Bypass).

  NOTE: this runs inside YOUR PowerShell session (iex), so it never calls `exit`
  (that would close your window) - it uses throw/return and restores state.
#>
param(
  [switch]$Yes,
  [switch]$DryRun,
  [switch]$Residency,
  [switch]$NoResidency,
  [switch]$SkipAuth,
  [string]$Dir,
  [string]$Ref
)

# Capture forwarding switches at SCRIPT scope (a helper function has its own).
$SeamForward = @()
foreach ($n in 'Yes','DryRun','Residency','NoResidency','SkipAuth') {
  if ($PSBoundParameters.ContainsKey($n) -and $PSBoundParameters[$n]) { $SeamForward += "-$n" }
}

$SeamPrevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Stop'
try {
  $RepoUrl = 'https://github.com/lettucebo/seam-acp.git'
  $ref = if ($Ref) { $Ref } elseif ($env:SEAM_ACP_REF) { $env:SEAM_ACP_REF } else { 'main' }
  $useColor = (-not $env:NO_COLOR) -and (-not [Console]::IsOutputRedirected)
  function _say($m, $c) { if ($useColor -and $c) { Write-Host $m -ForegroundColor $c } else { Write-Host $m } }

  _say "`n> seam-acp bootstrap" Cyan

  # --- ensure git -----------------------------------------------------------
  $gitOk = $false
  try { git --version *> $null; $gitOk = ($LASTEXITCODE -eq 0) } catch { $gitOk = $false }
  if (-not $gitOk) {
    _say "> Installing git" Cyan
    if ($DryRun) {
      _say "!  dry-run: would install git via winget/choco" Yellow
    } else {
      $pm = if (Get-Command winget -ErrorAction SilentlyContinue) { 'winget' }
            elseif (Get-Command choco -ErrorAction SilentlyContinue) { 'choco' }
            else { $null }
      if (-not $pm) {
        throw "git is required but neither winget nor Chocolatey is available. Install Git for Windows from https://git-scm.com/download/win and re-run."
      }
      if ($pm -eq 'winget') {
        winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements --silent
      } else {
        choco install git -y
      }
      if ($LASTEXITCODE -ne 0) { throw "git installation failed (exit $LASTEXITCODE). Install Git for Windows manually and re-run." }
      # Refresh PATH from the registry (the installed git isn't on this session's PATH yet).
      $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
      $user = [Environment]::GetEnvironmentVariable('Path', 'User')
      $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
      $gitOk = $false
      try { git --version *> $null; $gitOk = ($LASTEXITCODE -eq 0) } catch { $gitOk = $false }
      if (-not $gitOk) { throw "git still not found after install. Open a NEW terminal and re-run the one-liner." }
      _say "OK git installed" Green
    }
  } else {
    _say "OK git present" Green
  }

  # --- target directory -----------------------------------------------------
  $defaultDir = Join-Path $env:USERPROFILE 'seam-acp'
  $target =
    if ($Dir) { $Dir }
    elseif ($env:SEAM_ACP_DIR) { $env:SEAM_ACP_DIR }
    elseif ($Yes -or [Console]::IsInputRedirected) { $defaultDir }
    else {
      $ans = Read-Host "Where should seam-acp be installed? [$defaultDir]"
      if ([string]::IsNullOrWhiteSpace($ans)) { $defaultDir } else { $ans }
    }
  $target = [Environment]::ExpandEnvironmentVariables($target)
  if ($target -like '~*') { $target = Join-Path $env:USERPROFILE ($target -replace '^~[\\/]?', '') }
  if ([string]::IsNullOrWhiteSpace($target)) { throw "no target directory given" }

  # --- clone / reuse --------------------------------------------------------
  $doClone = $false
  if (Test-Path -LiteralPath $target) {
    $isRepo = (Test-Path -LiteralPath (Join-Path $target 'scripts\setup.mjs')) -and (Test-Path -LiteralPath (Join-Path $target '.git'))
    $originOk = $false
    if ($isRepo) { $o = (git -C $target remote get-url origin 2>$null); $originOk = ($o -match 'seam-acp') }
    if ($isRepo -and $originOk) {
      _say "OK using existing checkout at $target" Green
      _say "!  not auto-updating; run 'git -C `"$target`" pull' yourself to update." Yellow
    }
    elseif ((Get-ChildItem -Force -LiteralPath $target -ErrorAction SilentlyContinue | Measure-Object).Count -eq 0) {
      $doClone = $true
    }
    else {
      throw "target '$target' exists and is not a seam-acp checkout. Choose another with SEAM_ACP_DIR."
    }
  } else {
    $doClone = $true
  }

  if ($doClone) {
    if ($DryRun) {
      _say "!  dry-run: would clone $RepoUrl ($ref) -> $target (then run the installer)" Yellow
      _say "OK bootstrap dry-run complete (no checkout present to preview the full install)" Green
      return
    }
    _say "> Cloning seam-acp ($ref) -> $target" Cyan
    git clone --branch $ref -- $RepoUrl $target
    if ($LASTEXITCODE -ne 0) { throw "git clone failed (ref '$ref', target '$target')" }
    _say "OK cloned" Green
  }

  $installer = Join-Path $target 'install.ps1'
  if (-not (Test-Path -LiteralPath $installer)) { throw "install.ps1 missing in $target (incomplete checkout?)" }

  # --- hand off to the repo installer in a CHILD process --------------------
  # A child process isolates the user's session and applies ExecutionPolicy
  # Bypass to the cloned .ps1 (the outer iex bypass does NOT carry over).
  $hostExe = (Get-Process -Id $PID -ErrorAction SilentlyContinue).Path
  if (-not $hostExe) { $hostExe = 'powershell.exe' }
  _say "> Handing off to installer" Cyan
  & $hostExe -NoProfile -ExecutionPolicy Bypass -File $installer @SeamForward
}
catch {
  Write-Host "X  $($_.Exception.Message)" -ForegroundColor Red
}
finally {
  $ErrorActionPreference = $SeamPrevEAP
}
