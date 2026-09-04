<#
  delete-orders.ps1 — soft-delete one or more orders (and their items + renewals).

  The app has no delete-order action; every read filters on deleted_at IS NULL,
  so setting that column hides the order everywhere while keeping the row (and its
  audit trail) recoverable.

  Reads the database connection from a .env file (DATABASE_URL) so no password is
  typed or stored in this script. Shows what will go, asks you to confirm, then does it.

  USAGE (from the server, in a normal PowerShell window):
    .\delete-orders.ps1 -Orders ORD-2026-0001,ORD-2026-0002
    .\delete-orders.ps1 -Orders ORD-2026-0002 -EnvFile C:\Projects\NodeApps\CrmApi\.env

  If -EnvFile is omitted it looks for .env next to this script, then one folder up.
#>

param(
  [string[]] $Orders   = @('ORD-2026-0001','ORD-2026-0002'),
  [string]   $EnvFile  = '',
  [string]   $PsqlPath = '',   # override if psql is somewhere unusual
  [switch]   $Force            # skip the "type DELETE" confirmation
)

$ErrorActionPreference = 'Stop'

# --- locate the .env and pull DATABASE_URL out of it -------------------------
if (-not $EnvFile) {
  foreach ($c in @(
      (Join-Path $PSScriptRoot '.env'),
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
if (-not $dbUrl) {
  Write-Host "DATABASE_URL not found in $EnvFile" -ForegroundColor Red
  exit 1
}
Write-Host "Using connection from: $EnvFile" -ForegroundColor DarkGray

# --- locate psql -------------------------------------------------------------
$psql = $PsqlPath
if (-not $psql) { $psql = (Get-Command psql -ErrorAction SilentlyContinue).Source }
if (-not $psql) {
  $roots = @('C:\Program Files\PostgreSQL','C:\Program Files (x86)\PostgreSQL',
             'C:\PostgreSQL','C:\appPostgreSQL','D:\appPostgreSQL','D:\PostgreSQL')
  foreach ($root in $roots) {
    if (Test-Path $root) {
      $hit = Get-ChildItem "$root\*\bin\psql.exe" -ErrorAction SilentlyContinue |
             Select-Object -First 1 -ExpandProperty FullName
      if ($hit) { $psql = $hit; break }
    }
  }
}
if (-not $psql -or -not (Test-Path $psql)) {
  Write-Host "psql not found. Pass its path: -PsqlPath 'C:\Program Files\PostgreSQL\16\bin\psql.exe'" -ForegroundColor Red
  exit 1
}
Write-Host "Using psql: $psql" -ForegroundColor DarkGray

# --- build a safe IN (...) list ---------------------------------------------
$inList = ($Orders | ForEach-Object { "'" + ($_ -replace "'","''") + "'" }) -join ','

# --- show what will be deleted ----------------------------------------------
Write-Host "`nOrders that will be soft-deleted:`n" -ForegroundColor Cyan
& $psql $dbUrl -P pager=off -c @"
SELECT o.order_number, o.customer_name, o.total_amount, o.stage,
       (SELECT count(*) FROM order_items i WHERE i.order_id=o.id AND i.deleted_at IS NULL) AS items,
       (SELECT count(*) FROM renewals  r WHERE r.order_id=o.id AND r.deleted_at IS NULL) AS renewals
FROM orders o
WHERE o.order_number IN ($inList) AND o.deleted_at IS NULL
ORDER BY o.order_number;
"@

# --- confirm -----------------------------------------------------------------
if (-not $Force) {
  $ans = Read-Host "`nType DELETE to remove these (anything else cancels)"
  if ($ans -ne 'DELETE') { Write-Host 'Cancelled — nothing changed.' -ForegroundColor Yellow; exit 0 }
}

# --- one transaction: renewals, then items, then the orders ------------------
& $psql $dbUrl -v ON_ERROR_STOP=1 -c @"
BEGIN;
UPDATE renewals   SET deleted_at=now() WHERE deleted_at IS NULL AND order_id IN (SELECT id FROM orders WHERE order_number IN ($inList));
UPDATE order_items SET deleted_at=now() WHERE deleted_at IS NULL AND order_id IN (SELECT id FROM orders WHERE order_number IN ($inList));
UPDATE orders     SET deleted_at=now() WHERE deleted_at IS NULL AND order_number IN ($inList);
COMMIT;
"@

# --- confirm they are gone ---------------------------------------------------
Write-Host "`nRemaining rows for those order numbers (expect none):" -ForegroundColor Cyan
& $psql $dbUrl -P pager=off -c "SELECT order_number FROM orders WHERE order_number IN ($inList) AND deleted_at IS NULL;"
Write-Host "`nDone." -ForegroundColor Green
