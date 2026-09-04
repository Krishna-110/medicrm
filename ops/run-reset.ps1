<#
  run-reset.ps1 — run reset-production.sql without typing a password.

  Reads the database connection from your .env (DATABASE_URL), so it uses the
  same credentials the app already uses — no postgres password prompt, no psql
  on PATH required. Shows the current row counts, asks you to confirm, runs the
  reset, then shows the counts again.

  USAGE (on the server, normal PowerShell window):
    .\run-reset.ps1 -EnvFile C:\Projects\NodeApps\CrmApi\.env

  If -EnvFile is omitted it looks for .env next to this script, then ..\ and ..\server\.
  reset-production.sql must sit in the same folder as this script.
#>

param(
  [string] $EnvFile  = '',
  [string] $PsqlPath = '',
  [switch] $Force
)

$ErrorActionPreference = 'Stop'
$sqlFile = Join-Path $PSScriptRoot 'reset-production.sql'
if (-not (Test-Path $sqlFile)) {
  Write-Host "reset-production.sql not found next to this script ($PSScriptRoot)." -ForegroundColor Red
  exit 1
}

# --- .env / DATABASE_URL -----------------------------------------------------
if (-not $EnvFile) {
  foreach ($c in @((Join-Path $PSScriptRoot '.env'),
                   (Join-Path $PSScriptRoot '..\.env'),
                   (Join-Path $PSScriptRoot '..\server\.env'))) {
    if (Test-Path $c) { $EnvFile = $c; break }
  }
}
if (-not $EnvFile -or -not (Test-Path $EnvFile)) {
  Write-Host "Could not find a .env. Pass one: -EnvFile C:\path\to\.env" -ForegroundColor Red
  exit 1
}
$dbUrl = (Get-Content $EnvFile | Where-Object { $_ -match '^\s*DATABASE_URL\s*=' } |
          Select-Object -First 1) -replace '^\s*DATABASE_URL\s*=\s*', '' -replace '^"|"$', ''
if (-not $dbUrl) { Write-Host "DATABASE_URL not found in $EnvFile" -ForegroundColor Red; exit 1 }
Write-Host "Using connection from: $EnvFile" -ForegroundColor DarkGray

# --- psql --------------------------------------------------------------------
$psql = $PsqlPath
if (-not $psql) { $psql = (Get-Command psql -ErrorAction SilentlyContinue).Source }
if (-not $psql) {
  foreach ($root in @('C:\Program Files\PostgreSQL','C:\Program Files (x86)\PostgreSQL',
                      'C:\PostgreSQL','C:\appPostgreSQL','D:\appPostgreSQL','D:\PostgreSQL')) {
    if (Test-Path $root) {
      $hit = Get-ChildItem "$root\*\bin\psql.exe" -ErrorAction SilentlyContinue |
             Select-Object -First 1 -ExpandProperty FullName
      if ($hit) { $psql = $hit; break }
    }
  }
}
if (-not $psql -or -not (Test-Path $psql)) {
  Write-Host "psql not found. Pass -PsqlPath 'C:\Program Files\PostgreSQL\16\bin\psql.exe'" -ForegroundColor Red
  exit 1
}
Write-Host "Using psql: $psql`n" -ForegroundColor DarkGray

# --- show current state ------------------------------------------------------
Write-Host "Current data (what the reset will clear):" -ForegroundColor Cyan
& $psql $dbUrl -P pager=off -c @"
SELECT 'leads' t, count(*) FROM leads WHERE deleted_at IS NULL
UNION ALL SELECT 'orders', count(*) FROM orders WHERE deleted_at IS NULL
UNION ALL SELECT 'renewals', count(*) FROM renewals WHERE deleted_at IS NULL
UNION ALL SELECT 'follow_ups', count(*) FROM follow_ups WHERE deleted_at IS NULL
UNION ALL SELECT 'customers', count(*) FROM customers WHERE deleted_at IS NULL
UNION ALL SELECT 'users', count(*) FROM users WHERE deleted_at IS NULL
UNION ALL SELECT 'medicines (KEPT)', count(*) FROM products WHERE deleted_at IS NULL
UNION ALL SELECT 'stock units (KEPT)', coalesce(sum(quantity),0) FROM product_location_stock;
"@

Write-Host "`nThis clears every lead, order, renewal, follow-up and customer, and all" -ForegroundColor Yellow
Write-Host "accounts except admin@gmail.com and mohitdeshwal27@gmail.com." -ForegroundColor Yellow
Write-Host "Inventory (medicines, locations, stock) is kept. This cannot be undone." -ForegroundColor Yellow

if (-not $Force) {
  $ans = Read-Host "`nType RESET to proceed (anything else cancels)"
  if ($ans -ne 'RESET') { Write-Host 'Cancelled — nothing changed.' -ForegroundColor Yellow; exit 0 }
}

# --- run it ------------------------------------------------------------------
Write-Host "`nRunning reset-production.sql ...`n" -ForegroundColor Cyan
& $psql $dbUrl -v ON_ERROR_STOP=1 -f $sqlFile
Write-Host "`nDone. Every dashboard card should now read 0 (inventory untouched)." -ForegroundColor Green
