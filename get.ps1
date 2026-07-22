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

  NOTE: this runs inside YOUR PowerShell session (iex). The whole body runs in an
  isolated child scope (& { ... }) so it does NOT leak variables/functions into
  your session, and it NEVER calls `exit` (that would close your window) - it uses
  throw/return. Errors propagate as terminating errors, not by closing the shell.
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

& {
  param(
    [switch]$Yes, [switch]$DryRun, [switch]$Residency, [switch]$NoResidency,
    [switch]$SkipAuth, [string]$Dir, [string]$Ref
  )
  # $ErrorActionPreference is set in this child scope only - it does not leak.
  $ErrorActionPreference = 'Stop'

  $forward = @()
  foreach ($n in 'Yes', 'DryRun', 'Residency', 'NoResidency', 'SkipAuth') {
    if ($PSBoundParameters.ContainsKey($n) -and $PSBoundParameters[$n]) { $forward += "-$n" }
  }

  $repoUrl = 'https://github.com/lettucebo/seam-acp.git'
  $ref = if ($Ref) { $Ref } elseif ($env:SEAM_ACP_REF) { $env:SEAM_ACP_REF } else { 'main' }
  $useColor = (-not $env:NO_COLOR) -and (-not [Console]::IsOutputRedirected)
  function _say($m, $c) { if ($useColor -and $c) { Write-Host $m -ForegroundColor $c } else { Write-Host $m } }

  _say "`n> seam-acp bootstrap" Cyan

  # --- ensure git -----------------------------------------------------------
  $gitOk = $false
  try { git --version *> $null; $gitOk = ($LASTEXITCODE -eq 0) } catch { $gitOk = $false }
  if (-not $gitOk) {
    if ($DryRun) {
      _say "!  dry-run: would install git via winget/choco" Yellow
    } else {
      $pm = if (Get-Command winget -ErrorAction SilentlyContinue) { 'winget' }
            elseif (Get-Command choco -ErrorAction SilentlyContinue) { 'choco' }
            else { $null }
      if (-not $pm) {
        throw "git is required but neither winget nor Chocolatey is available. Install Git for Windows from https://git-scm.com/download/win and re-run."
      }
      if (-not ($Yes -or [Console]::IsInputRedirected)) {
        $c = Read-Host "git is required and not installed. Install it now via $pm? (Y/n)"
        if ($c -match '^(n|no)$') { throw "git is required. Install it and re-run." }
      }
      _say "> Installing git via $pm" Cyan
      if ($pm -eq 'winget') {
        winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements --silent
      } else {
        choco install git -y
      }
      if ($LASTEXITCODE -ne 0) { throw "git installation failed (exit $LASTEXITCODE). Install Git for Windows manually and re-run." }
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

  # Exact identity check: origin must be THIS repo, not merely a URL containing
  # "seam-acp" (which would match a fork or a hostile lookalike).
  function _isOurRepo($dir) {
    $o = (git -C $dir remote get-url origin 2>$null)
    if (-not $o) { return $false }
    $norm = ($o -replace '\.git/?$', '') -replace '/$', ''
    return $norm -in @(
      'https://github.com/lettucebo/seam-acp',
      'git@github.com:lettucebo/seam-acp',
      'ssh://git@github.com/lettucebo/seam-acp'
    )
  }

  # --- clone / reuse --------------------------------------------------------
  $doClone = $false
  if (Test-Path -LiteralPath $target) {
    $isRepo = (Test-Path -LiteralPath (Join-Path $target 'scripts\setup.mjs')) -and (Test-Path -LiteralPath (Join-Path $target '.git'))
    if ($isRepo -and (_isOurRepo $target)) {
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
      _say "!  dry-run: would clone $repoUrl ($ref) -> $target (then run the installer)" Yellow
      _say "OK bootstrap dry-run complete (no checkout present to preview the full install)" Green
      return
    }
    _say "> Cloning seam-acp ($ref) -> $target" Cyan
    git clone --branch $ref -- $repoUrl $target
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
  & $hostExe -NoProfile -ExecutionPolicy Bypass -File $installer @forward
  if ($LASTEXITCODE -ne 0) { throw "installer exited with code $LASTEXITCODE" }
} @PSBoundParameters
