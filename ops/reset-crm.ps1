<#
  reset-crm.ps1 — reset the CRM to a clean slate. SELF-CONTAINED: the SQL is built
  in, so this is the ONLY file you need. No password to type (read from .env), no
  psql on PATH required (auto-found).

  Clears every lead, order, renewal, follow-up, customer, activity, notification
  and audit row, all sessions, and every account except admin@gmail.com and
  mohitdeshwal27@gmail.com. Resets admin's password to admin123 and restarts the
  order-number sequence. KEEPS the medicine catalogue, locations and stock.

  USAGE (on the server, normal PowerShell window):
    .\reset-crm.ps1 -EnvFile C:\Projects\NodeApps\CrmApi\.env

  If PowerShell blocks it: prepend  powershell -ExecutionPolicy Bypass -File
#>

param(
  [string] $EnvFile  = '',
  [string] $PsqlPath = '',
  [switch] $Force
)

$ErrorActionPreference = 'Stop'

# --- .env / DATABASE_URL -----------------------------------------------------
if (-not $EnvFile) {
  foreach ($c in @((Join-Path $PSScriptRoot '.env'),
                   (Join-Path $PSScriptRoot '..\.env'),
                   (Join-Path $PSScriptRoot '..\server\.env'))) {
    if (Test-Path $c) { $EnvFile = $c; break }
  }
}
if (-not $EnvFile -or -not (Test-Path $EnvFile)) {
  Write-Host "Could not find a .env. Pass one: -EnvFile C:\path\to\.env" -ForegroundColor Red; exit 1
}
$dbUrl = (Get-Content $EnvFile | Where-Object { $_ -match '^\s*DATABASE_URL\s*=' } |
          Select-Object -First 1) -replace '^\s*DATABASE_URL\s*=\s*','' -replace '^"|"$',''
if (-not $dbUrl) { Write-Host "DATABASE_URL not found in $EnvFile" -ForegroundColor Red; exit 1 }
# Prisma appends ?schema=public (and sometimes connection_limit etc.) — libpq/psql
# rejects the 'schema' parameter, so drop the whole query string. 'public' is the
# default schema anyway, and this connects to the same local database.
$dbUrl = $dbUrl -replace '\?.*$',''
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
  Write-Host "psql not found. Pass -PsqlPath 'C:\Program Files\PostgreSQL\16\bin\psql.exe'" -ForegroundColor Red; exit 1
}
Write-Host "Using psql: $psql`n" -ForegroundColor DarkGray

# --- the reset SQL (single-quoted here-string: the $ in the hash stays literal) --
$sql = @'
BEGIN;
DELETE FROM notifications;
DELETE FROM audit_log;
DELETE FROM lead_activities;
DELETE FROM lead_assignments;
DELETE FROM lead_medicines;
DELETE FROM follow_ups;
DELETE FROM renewals;
DELETE FROM order_items;
DELETE FROM orders;
DELETE FROM leads;
DELETE FROM customers;
DELETE FROM sessions;
DELETE FROM users WHERE lower(email) NOT IN ('admin@gmail.com', 'mohitdeshwal27@gmail.com');
INSERT INTO users (id, employee_id, name, phone, email, password_hash, role, status,
                   assigned_leads_count, created_at, updated_at)
VALUES (gen_random_uuid(), 'ADM001', 'Admin', '0000000000', 'admin@gmail.com',
        '$2b$10$WLFgs7URzufks6TacDv5R.ojslizKGeknDIQQMjrweCVIx7u5K.xa', 'admin', 'active', 0, now(), now())
ON CONFLICT (email) DO UPDATE
   SET password_hash = EXCLUDED.password_hash, role='admin', status='active',
       deleted_at=NULL, updated_at=now();
UPDATE users SET assigned_leads_count = 0;
ALTER SEQUENCE order_number_seq RESTART WITH 1;
COMMIT;
SELECT 'users' AS table, count(*) FROM users
UNION ALL SELECT 'leads', count(*) FROM leads
UNION ALL SELECT 'orders', count(*) FROM orders
UNION ALL SELECT 'renewals', count(*) FROM renewals
UNION ALL SELECT 'follow_ups', count(*) FROM follow_ups
UNION ALL SELECT 'customers', count(*) FROM customers
UNION ALL SELECT 'products KEPT', count(*) FROM products
UNION ALL SELECT 'stock units KEPT', coalesce(sum(quantity),0) FROM product_location_stock;
'@

# --- show current state ------------------------------------------------------
Write-Host "Current data (what the reset will clear):" -ForegroundColor Cyan
& $psql $dbUrl -P pager=off -c @"
SELECT 'leads' t, count(*) FROM leads WHERE deleted_at IS NULL
UNION ALL SELECT 'orders', count(*) FROM orders WHERE deleted_at IS NULL
UNION ALL SELECT 'follow_ups', count(*) FROM follow_ups WHERE deleted_at IS NULL
UNION ALL SELECT 'customers', count(*) FROM customers WHERE deleted_at IS NULL
UNION ALL SELECT 'users', count(*) FROM users WHERE deleted_at IS NULL
UNION ALL SELECT 'medicines (KEPT)', count(*) FROM products WHERE deleted_at IS NULL
UNION ALL SELECT 'stock units (KEPT)', coalesce(sum(quantity),0) FROM product_location_stock;
"@

Write-Host "`nThis clears every lead, order, renewal, follow-up and customer, and all" -ForegroundColor Yellow
Write-Host "accounts except admin@gmail.com and mohitdeshwal27@gmail.com. Inventory is" -ForegroundColor Yellow
Write-Host "kept. admin's password becomes admin123. This cannot be undone." -ForegroundColor Yellow

if (-not $Force) {
  $ans = Read-Host "`nType RESET to proceed (anything else cancels)"
  if ($ans -ne 'RESET') { Write-Host 'Cancelled - nothing changed.' -ForegroundColor Yellow; exit 0 }
}

# --- run it: pipe the SQL to psql over stdin -------------------------------
# stdin, not a temp file, on purpose: Set-Content on Windows PowerShell writes a
# UTF-8 BOM, and psql reports the BOM as a syntax error at "BEGIN". Piping sends
# the bytes clean.
Write-Host "`nRunning reset ...`n" -ForegroundColor Cyan
$sql | & $psql $dbUrl -v ON_ERROR_STOP=1 -f -
if ($LASTEXITCODE -eq 0) {
  Write-Host "`nDone. Every dashboard card should now read 0 (inventory untouched)." -ForegroundColor Green
} else {
  Write-Host "`nFAILED - psql exited with code $LASTEXITCODE. Nothing was changed (it runs in one transaction)." -ForegroundColor Red
}
