<#
  reset-crm.ps1 — reset the CRM to a clean production slate with live stock & prices.
  SELF-CONTAINED: the SQL is built in, so this is the ONLY file you need.
  No password to type (read from .env), no psql on PATH required (auto-found).

  WHAT IT DOES:
    1. Clears all test transactions (leads, customers, orders, renewals, follow-ups,
       notifications, activities, assignments, audit logs, and sessions).
    2. Keeps existing admin user credentials (ID and password) 100% untouched.
       Deletes non-admin test callers.
    3. Removes "Main Store" and configures only the 3 official stores: Madlauda, Shamli, Samalkha.
    4. Updates the 18 Ayurvedic medicines with their updated prices (matched by medicine name).
    5. Sets exact inventory for Madlauda, Shamli, and Samalkha (1,256 total units).
    6. Restarts order-number sequence at 1 (ORD-YYYY-0001).

  USAGE (on the server, in a normal PowerShell window):
    .\reset-crm.ps1 -EnvFile C:\Projects\NodeApps\CrmApi\.env

  If PowerShell execution policy blocks scripts:
    powershell -ExecutionPolicy Bypass -File .\reset-crm.ps1 -EnvFile C:\Projects\NodeApps\CrmApi\.env
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

# Prisma appends ?schema=public — libpq/psql rejects the 'schema' parameter, so drop the query string.
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

# --- the reset SQL -----------------------------------------------------------
$sql = @'
BEGIN;

-- 1. Clear working / transactional data (children first)
DELETE FROM "notifications";
DELETE FROM "audit_log";
DELETE FROM "lead_activities";
DELETE FROM "lead_assignments";
DELETE FROM "lead_medicines";
DELETE FROM "follow_ups";
DELETE FROM "renewals";
DELETE FROM "order_items";
DELETE FROM "orders";
DELETE FROM "leads";
DELETE FROM "customers";
DELETE FROM "sessions";

-- 2. Keep admin user ID & password intact; delete non-admin test callers
DELETE FROM "users" WHERE "role" != 'admin';
UPDATE "users"
SET "assigned_leads_count" = 0,
    "last_login_at" = NULL
WHERE "role" = 'admin';

-- 3. Clear existing stock associations
DELETE FROM "product_location_stock";

-- 4. Delete demo allopathic medicines if present
DELETE FROM "products"
WHERE LOWER(TRIM(COALESCE("brand_name", "generic_name"))) IN (
  'paracetamol', 'azithral', 'eltroxin', 'lantus', 'atorva', 'amlopres', 'glycomet'
);

-- 5. Upsert the 3 official stores: Madlauda, Shamli, Samalkha
INSERT INTO "locations" ("id", "name", "created_at", "updated_at")
VALUES
  (gen_random_uuid(), 'Madlauda', now(), now()),
  (gen_random_uuid(), 'Shamli', now(), now()),
  (gen_random_uuid(), 'Samalkha', now(), now())
ON CONFLICT ("name") DO UPDATE
  SET "deleted_at" = NULL, "updated_at" = now();

-- 6. Unassign any other locations from users & delete them (specifically removes "Main Store")
UPDATE "users"
SET "location_id" = NULL
WHERE "location_id" IN (
  SELECT "id" FROM "locations"
  WHERE "name" NOT IN ('Madlauda', 'Shamli', 'Samalkha')
);

DELETE FROM "locations"
WHERE "name" NOT IN ('Madlauda', 'Shamli', 'Samalkha');

-- 7. Ensure the 18 Ayurvedic medicines exist in products
INSERT INTO "products" ("id", "sku", "generic_name", "brand_name", "dosage_form", "unit_price", "stock_quantity", "is_active", "created_at", "updated_at")
SELECT
  gen_random_uuid(),
  'MED-' || substr(md5(random()::text), 1, 8),
  m.name,
  m.name,
  m.dosage_form,
  m.price,
  0,
  true,
  now(),
  now()
FROM (
  VALUES
    ('Tejasvi Ark',            'other',   600::numeric),
    ('Tejasvi Kadha',          'other',   600::numeric),
    ('Vedic Shiv Amrit Ark',   'other',   600::numeric),
    ('Vedic Shiv Amrit Syrup', 'syrup',   600::numeric),
    ('Anus Care 1',            'other',   600::numeric),
    ('Anus Care 2',            'other',   600::numeric),
    ('Anus Care Cream',        'other',   300::numeric),
    ('Kamaking Capsule',       'capsule', 1500::numeric),
    ('Kamaking Oil',           'other',   500::numeric),
    ('Asthma Powder',          'other',   800::numeric),
    ('Asthma Tab',             'tablet',  800::numeric),
    ('Ashwashila Malt',        'other',   2500::numeric),
    ('Weight Gain Powder',     'other',   1500::numeric),
    ('Weight Loss Powder',     'other',   1000::numeric),
    ('Kidney Kaya Syrup',      'syrup',   800::numeric),
    ('Lady Gold Ark',          'other',   800::numeric),
    ('Sansamrit',              'other',   800::numeric),
    ('Dardantak Powder',       'other',   800::numeric)
) AS m(name, dosage_form, price)
WHERE NOT EXISTS (
  SELECT 1 FROM "products" p
  WHERE LOWER(TRIM(COALESCE(p."brand_name", p."generic_name"))) = LOWER(TRIM(m.name))
);

-- 8. Update unit prices for all 18 medicines by matching their medicine name
UPDATE "products" p
SET "unit_price" = m.price,
    "is_active" = true,
    "deleted_at" = NULL,
    "updated_at" = now()
FROM (
  VALUES
    ('Tejasvi Ark',            600::numeric),
    ('Tejasvi Kadha',          600::numeric),
    ('Vedic Shiv Amrit Ark',   600::numeric),
    ('Vedic Shiv Amrit Syrup', 600::numeric),
    ('Anus Care 1',            600::numeric),
    ('Anus Care 2',            600::numeric),
    ('Anus Care Cream',        300::numeric),
    ('Kamaking Capsule',      1500::numeric),
    ('Kamaking Oil',           500::numeric),
    ('Asthma Powder',          800::numeric),
    ('Asthma Tab',             800::numeric),
    ('Ashwashila Malt',       2500::numeric),
    ('Weight Gain Powder',    1500::numeric),
    ('Weight Loss Powder',    1000::numeric),
    ('Kidney Kaya Syrup',      800::numeric),
    ('Lady Gold Ark',          800::numeric),
    ('Sansamrit',              800::numeric),
    ('Dardantak Powder',       800::numeric)
) AS m(medicine_name, price)
WHERE LOWER(TRIM(COALESCE(p."brand_name", p."generic_name"))) = LOWER(TRIM(m.medicine_name));

-- 9. Insert physical inventory for Madlauda, Shamli, and Samalkha matched by medicine name
INSERT INTO "product_location_stock" ("id", "product_id", "location_id", "quantity", "created_at", "updated_at")
SELECT
  gen_random_uuid(),
  p.id,
  l.id,
  s.qty,
  now(),
  now()
FROM (
  VALUES
    -- Medicine Name           Madlauda  Shamli  Samalkha
    ('Tejasvi Ark',                  14,      8,       40),
    ('Tejasvi Kadha',                14,      8,       40),
    ('Vedic Shiv Amrit Ark',         10,     10,       35),
    ('Vedic Shiv Amrit Syrup',       10,     10,       35),
    ('Anus Care 1',                   6,      4,       22),
    ('Anus Care 2',                   6,     18,       22),
    ('Anus Care Cream',               2,      3,       15),
    ('Kamaking Capsule',              8,      4,       80),
    ('Kamaking Oil',                  2,      3,       15),
    ('Asthma Powder',                10,     12,      220),
    ('Asthma Tab',                   10,     12,       80),
    ('Ashwashila Malt',               3,      5,       90),
    ('Weight Gain Powder',            3,      5,       32),
    ('Weight Loss Powder',            3,      6,       50),
    ('Kidney Kaya Syrup',            10,      4,       40),
    ('Lady Gold Ark',                10,      9,       30),
    ('Sansamrit',                     8,      8,       20),
    ('Dardantak Powder',             10,      6,      116)
) AS v(medicine_name, madlauda_qty, shamli_qty, samalkha_qty)
CROSS JOIN LATERAL (
  VALUES
    ('Madlauda', v.madlauda_qty),
    ('Shamli',   v.shamli_qty),
    ('Samalkha', v.samalkha_qty)
) AS s(store_name, qty)
JOIN "products" p
  ON LOWER(TRIM(COALESCE(p."brand_name", p."generic_name"))) = LOWER(TRIM(v.medicine_name))
JOIN "locations" l
  ON LOWER(TRIM(l."name")) = LOWER(TRIM(s.store_name)) AND l."deleted_at" IS NULL;

-- 10. Recompute headline stock_quantity on products (sum of location stocks)
UPDATE "products" p
SET "stock_quantity" = COALESCE((
  SELECT SUM(s."quantity")
  FROM "product_location_stock" s
  WHERE s."product_id" = p."id"
), 0),
"updated_at" = now();

-- 11. Restart order numbering sequence at 1
ALTER SEQUENCE IF EXISTS order_number_seq RESTART WITH 1;

COMMIT;

-- Verification summaries
SELECT 'admin users kept' AS metric, count(*)::text AS val FROM users WHERE role = 'admin'
UNION ALL SELECT 'callers remaining', count(*)::text FROM users WHERE role != 'admin'
UNION ALL SELECT 'leads', count(*)::text FROM leads
UNION ALL SELECT 'orders', count(*)::text FROM orders
UNION ALL SELECT 'customers', count(*)::text FROM customers
UNION ALL SELECT 'medicines active', count(*)::text FROM products WHERE is_active = true AND deleted_at IS NULL
UNION ALL SELECT 'stores (3)', count(*)::text FROM locations
UNION ALL SELECT 'total stock units (1256)', coalesce(sum(quantity),0)::text FROM product_location_stock;

SELECT l.name AS store, coalesce(sum(s.quantity), 0) AS total_units
FROM locations l
LEFT JOIN product_location_stock s ON s.location_id = l.id
GROUP BY l.name
ORDER BY l.name;

SELECT coalesce(p.brand_name, p.generic_name) AS medicine_name,
       p.unit_price AS price,
       max(CASE WHEN l.name = 'Madlauda' THEN s.quantity ELSE 0 END) AS madlauda,
       max(CASE WHEN l.name = 'Shamli'   THEN s.quantity ELSE 0 END) AS shamli,
       max(CASE WHEN l.name = 'Samalkha' THEN s.quantity ELSE 0 END) AS samalkha,
       p.stock_quantity AS total_stock
FROM products p
LEFT JOIN product_location_stock s ON s.product_id = p.id
LEFT JOIN locations l ON l.id = s.location_id
WHERE LOWER(TRIM(COALESCE(p.brand_name, p.generic_name))) IN (
  'tejasvi ark', 'tejasvi kadha', 'vedic shiv amrit ark', 'vedic shiv amrit syrup',
  'anus care 1', 'anus care 2', 'anus care cream', 'kamaking capsule', 'kamaking oil',
  'asthma powder', 'asthma tab', 'ashwashila malt', 'weight gain powder', 'weight loss powder',
  'kidney kaya syrup', 'lady gold ark', 'sansamrit', 'dardantak powder'
)
GROUP BY p.id, p.brand_name, p.generic_name, p.unit_price, p.stock_quantity
ORDER BY coalesce(p.brand_name, p.generic_name);
'@

# --- show current state ------------------------------------------------------
Write-Host "Current data (what the reset will clear):" -ForegroundColor Cyan
& $psql $dbUrl -P pager=off -c @"
SELECT 'leads' t, count(*) FROM leads WHERE deleted_at IS NULL
UNION ALL SELECT 'orders', count(*) FROM orders WHERE deleted_at IS NULL
UNION ALL SELECT 'follow_ups', count(*) FROM follow_ups WHERE deleted_at IS NULL
UNION ALL SELECT 'customers', count(*) FROM customers WHERE deleted_at IS NULL
UNION ALL SELECT 'admin users (KEPT)', count(*) FROM users WHERE role = 'admin' AND deleted_at IS NULL
UNION ALL SELECT 'test callers (will delete)', count(*) FROM users WHERE role != 'admin' AND deleted_at IS NULL
UNION ALL SELECT 'current stock units', coalesce(sum(quantity),0) FROM product_location_stock;
"@

Write-Host "`nWHAT WILL HAPPEN:" -ForegroundColor Yellow
Write-Host "  * All test leads, orders, renewals, follow-ups, customers, and test callers will be deleted." -ForegroundColor Yellow
Write-Host "  * Admin user credentials (ID and password) are 100% PRESERVED." -ForegroundColor Yellow
Write-Host "  * 'Main Store' is removed. Only Madlauda, Shamli, and Samalkha will exist." -ForegroundColor Yellow
Write-Host "  * All 18 Ayurvedic medicines will have their prices updated and stock populated (1,256 total units)." -ForegroundColor Yellow
Write-Host "  * Order number sequence resets to 1 (ORD-YYYY-0001)." -ForegroundColor Yellow

if (-not $Force) {
  $ans = Read-Host "`nType RESET to proceed (anything else cancels)"
  if ($ans -ne 'RESET') { Write-Host 'Cancelled - nothing changed.' -ForegroundColor Yellow; exit 0 }
}

# --- run it: pipe the SQL to psql over stdin -------------------------------
Write-Host "`nRunning reset ...`n" -ForegroundColor Cyan
$sql | & $psql $dbUrl -v ON_ERROR_STOP=1 -f -
if ($LASTEXITCODE -eq 0) {
  Write-Host "`nDone. Live database reset successfully with updated stock and prices!" -ForegroundColor Green
} else {
  Write-Host "`nFAILED - psql exited with code $LASTEXITCODE. Nothing was changed (transaction rolled back)." -ForegroundColor Red
}
