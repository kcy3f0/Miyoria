<#
.SYNOPSIS
  Restore a dump made by scripts\backup.ps1 into the compose PostgreSQL database.
  THIS REPLACES THE CURRENT DATA IN THE DATABASE.
.EXAMPLE
  scripts\restore.ps1 backups\miyoria-20260101-030000.dump
  scripts\restore.ps1 -Latest            # newest dump in backups\
  scripts\restore.ps1 -Yes <file>        # no confirmation prompt
.NOTES
  If the core container is running (compose profile `core`) it is stopped first and started again
  afterwards. A core running on the host (miyoria core) must be stopped by you first.
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$File,
  [switch]$Latest,
  [switch]$Yes,
  [string]$Dir
)
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
if (-not $Dir) { $Dir = if ($env:BACKUP_DIR) { $env:BACKUP_DIR } else { Join-Path $Root 'backups' } }
$ComposeFile = Join-Path $Root 'deploy\docker-compose.yml'

if ($Latest) {
  $newest = Get-ChildItem -Path $Dir -Filter 'miyoria-*.dump' -File -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1
  if (-not $newest) { throw "no dumps in $Dir" }
  $File = $newest.FullName
}
if (-not $File) { throw 'give a dump file, or use -Latest' }
if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { throw "no such file: $File" }
$File = (Resolve-Path -LiteralPath $File).Path

function Get-EnvValue([string]$Name) {
  $envFile = Join-Path $Root 'deploy\.env'
  if (-not (Test-Path $envFile)) { return $null }
  $line = Get-Content $envFile | Where-Object { $_ -match "^\s*$([regex]::Escape($Name))=" } | Select-Object -Last 1
  if (-not $line) { return $null }
  return ($line -replace '^[^=]*=', '').Trim().Trim('"').Trim("'")
}

function Invoke-Compose {
  # Compose prints progress on stderr, which Windows PowerShell 5.1 would turn into an error
  # under 'Stop'; success is judged by the exit code only.
  $ErrorActionPreference = 'Continue'
  & docker compose -f $ComposeFile @args
  if ($LASTEXITCODE -ne 0) { throw "docker compose $($args -join ' ') failed (exit $LASTEXITCODE)" }
}

$PgUser = if ($env:POSTGRES_USER) { $env:POSTGRES_USER } else { Get-EnvValue 'POSTGRES_USER' }
if (-not $PgUser) { $PgUser = 'miyoria' }
$PgDb = if ($env:POSTGRES_DB) { $env:POSTGRES_DB } else { Get-EnvValue 'POSTGRES_DB' }
if (-not $PgDb) { $PgDb = 'miyoria' }

function Invoke-Probe([scriptblock]$Block) {
  # Run a native command whose failure is an expected answer, not an error.
  $ErrorActionPreference = 'Continue'
  & $Block 2>$null
}

Invoke-Probe { docker info } | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'cannot reach the Docker daemon (is Docker Desktop running?)' }
$running = Invoke-Probe { docker compose -f $ComposeFile ps --status running --quiet postgres }
if (-not $running) {
  throw 'the postgres service is not running. Start it: docker compose -f deploy\docker-compose.yml up -d postgres'
}

if (-not $Yes) {
  $answer = Read-Host "Restore $File into database '$PgDb'? Current data will be replaced. [y/N]"
  if ($answer -notmatch '^(y|yes)$') { Write-Host 'aborted'; exit 1 }
}

# The core service sits behind a profile and its env_file needs the repo-root .env.
$coreWasRunning = $false
if (Test-Path (Join-Path $Root '.env')) {
  $coreRunning = Invoke-Probe { docker compose -f $ComposeFile --profile core ps --status running --quiet core }
  if ($coreRunning) {
    $coreWasRunning = $true
    Write-Host 'stopping core ...'
    Invoke-Compose --profile core stop core
  }
}

$Remote = "/tmp/restore-$PID.dump"
try {
  Invoke-Compose cp $File "postgres:$Remote"
  Invoke-Probe { docker compose -f $ComposeFile exec -T postgres pg_restore --list $Remote } | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "$File is not a valid pg_dump custom-format archive" }

  Write-Host 'restoring ...'
  # --clean --if-exists drops existing objects first; --single-transaction rolls back on error.
  Invoke-Compose exec -T postgres pg_restore -U $PgUser -d $PgDb --clean --if-exists --no-owner --single-transaction $Remote
  Write-Host "ok: restored $File"
}
finally {
  Invoke-Probe { docker compose -f $ComposeFile exec -T postgres rm -f $Remote } | Out-Null
}

if ($coreWasRunning) {
  Write-Host 'starting core ...'
  Invoke-Compose --profile core start core
}
