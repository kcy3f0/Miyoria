<#
.SYNOPSIS
  Back up the compose PostgreSQL database (deploy/docker-compose.yml) with pg_dump.
.EXAMPLE
  scripts\backup.ps1                  # -> backups\miyoria-YYYYMMDD-HHMMSS.dump
  scripts\backup.ps1 -Keep 30         # keep the newest 30 dumps (default 14, 0 = keep all)
  scripts\backup.ps1 -Dir D:\nas      # write somewhere else
.NOTES
  POSTGRES_USER / POSTGRES_DB come from the environment, else deploy\.env, else "miyoria".
  Restore with scripts\restore.ps1. Works on Windows PowerShell 5.1 and PowerShell 7.
#>
[CmdletBinding()]
param(
  [int]$Keep = $(if ($env:BACKUP_KEEP) { [int]$env:BACKUP_KEEP } else { 14 }),
  [string]$Dir
)
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
if (-not $Dir) { $Dir = if ($env:BACKUP_DIR) { $env:BACKUP_DIR } else { Join-Path $Root 'backups' } }
$ComposeFile = Join-Path $Root 'deploy\docker-compose.yml'
if ($Keep -lt 0) { throw '-Keep must be >= 0' }

function Get-EnvValue([string]$Name) {
  $file = Join-Path $Root 'deploy\.env'
  if (-not (Test-Path $file)) { return $null }
  $line = Get-Content $file | Where-Object { $_ -match "^\s*$([regex]::Escape($Name))=" } | Select-Object -Last 1
  if (-not $line) { return $null }
  return ($line -replace '^[^=]*=', '').Trim().Trim('"').Trim("'")
}

function Invoke-Compose {
  # Runs docker compose; throws if it exits non-zero. Output is passed through. Compose prints
  # progress on stderr, which Windows PowerShell 5.1 would turn into an error under 'Stop'.
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

New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Out = Join-Path $Dir "miyoria-$Stamp.dump"
$Tmp = "$Out.partial"
$Remote = "/tmp/miyoria-$Stamp.dump"

try {
  Write-Host "dumping $PgDb (user $PgUser) ..."
  # Written inside the container and copied out: PowerShell 5.1 would corrupt binary data piped
  # through its native-command redirection.
  Invoke-Compose exec -T postgres pg_dump -U $PgUser -d $PgDb -Fc --no-owner -f $Remote
  Invoke-Compose cp "postgres:$Remote" $Tmp
  Invoke-Compose exec -T postgres pg_restore --list $Remote | Out-Null   # sanity check
  Move-Item -Force -LiteralPath $Tmp -Destination $Out
  $size = '{0:N1} MB' -f ((Get-Item $Out).Length / 1MB)
  Write-Host "ok: $Out ($size)"
}
finally {
  if (Test-Path $Tmp) { Remove-Item -Force $Tmp }
  Invoke-Probe { docker compose -f $ComposeFile exec -T postgres rm -f $Remote } | Out-Null
}

if ($Keep -gt 0) {
  # Names embed a sortable timestamp, so sorting by name descending is newest-first.
  Get-ChildItem -Path $Dir -Filter 'miyoria-*.dump' -File |
    Sort-Object Name -Descending |
    Select-Object -Skip $Keep |
    ForEach-Object { Remove-Item -Force $_.FullName; Write-Host "pruned: $($_.FullName)" }
}
