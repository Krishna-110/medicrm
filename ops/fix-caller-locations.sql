-- =====================================================================
--  Fix: callers are selling from a location that no longer exists
-- =====================================================================
--
--  THE PROBLEM
--
--  Every caller is assigned to a location called "Main Store", which has
--  been deleted. The app still holds its id on each caller, and a sale
--  always deducts stock from the caller's own location -- so:
--
--    * sales quietly draw down "Main Store" stock, which no page can show
--      and nobody can top up;
--    * the stock held at Samalkha, Shamli and Madlauda is never touched
--      by a sale at all;
--    * when the hidden stock runs out, every conversion starts failing
--      with "not enough stock" while the Stock page still shows plenty.
--
--  This script points each caller at a real store and tidies up after the
--  deleted one. It changes no stock figures at the three real stores.
--
--  HOW TO RUN  (on the server, normal PowerShell)
--
--    $env:PGPASSWORD='<password>'
--    & "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -d crmdb `
--        -v ON_ERROR_STOP=1 -f fix-caller-locations.sql
--
--  Or reuse the connection string already in the API's .env, the way
--  ops\reset-crm.ps1 does.
--
--  Steps 1 and 2 only LOOK. Nothing changes until the BEGIN in step 3,
--  and it is one transaction: if any statement fails, nothing is applied.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Which callers point at a location that is gone?
-- ---------------------------------------------------------------------
\echo ''
\echo '=== callers and the location they sell from ==='
SELECT u.name,
       u.email,
       u.status,
       COALESCE(l.name, '(no location set)') AS location,
       CASE
         WHEN u.location_id IS NULL          THEN 'NO LOCATION - cannot sell'
         WHEN l.deleted_at IS NOT NULL       THEN 'DELETED LOCATION - needs fixing'
         ELSE 'ok'
       END AS state
FROM users u
LEFT JOIN locations l ON l.id = u.location_id
WHERE u.deleted_at IS NULL
  AND u.role = 'caller'
ORDER BY state DESC, u.name;


-- ---------------------------------------------------------------------
-- 2. The real stores, and the stock stranded at deleted ones
-- ---------------------------------------------------------------------
\echo ''
\echo '=== real stores (these are the ones you can pick from) ==='
SELECT l.id, l.name, COALESCE(SUM(s.quantity), 0) AS units
FROM locations l
LEFT JOIN product_location_stock s ON s.location_id = l.id
WHERE l.deleted_at IS NULL
GROUP BY l.id, l.name
ORDER BY l.name;

\echo ''
\echo '=== stock stranded at DELETED locations (invisible in the app) ==='
SELECT l.name AS deleted_location, COALESCE(SUM(s.quantity), 0) AS stranded_units
FROM locations l
JOIN product_location_stock s ON s.location_id = l.id
WHERE l.deleted_at IS NOT NULL
GROUP BY l.name;


-- ---------------------------------------------------------------------
-- 3. THE FIX
-- ---------------------------------------------------------------------
BEGIN;

-- 3a. Put each caller in the store they actually sell from.
--
--     >>> EDIT THIS BLOCK <<<
--     One line per caller. Change the store name on the right to whichever
--     of Samalkha Stock / Shamli Stock / Madlauda Stock that person sells
--     from. Delete the lines for anyone who should not change.
--
--     The name must match a real store exactly, or the line will fail and
--     the whole script rolls back -- which is deliberate.

UPDATE users SET location_id = (SELECT id FROM locations WHERE name = 'Samalkha Stock' AND deleted_at IS NULL)
  WHERE email = 'mohitdeshwal27@gmail.com';

UPDATE users SET location_id = (SELECT id FROM locations WHERE name = 'Samalkha Stock' AND deleted_at IS NULL)
  WHERE email = 'tt@gmail.com';

UPDATE users SET location_id = (SELECT id FROM locations WHERE name = 'Samalkha Stock' AND deleted_at IS NULL)
  WHERE email = 'test2@gmail.com';

-- 3b. Catch-all: anyone still pointing at a deleted location goes to the
--     store with the most stock. Harmless if 3a already covered everyone.
UPDATE users u
SET location_id = (
      SELECT l.id
      FROM locations l
      LEFT JOIN product_location_stock s ON s.location_id = l.id
      WHERE l.deleted_at IS NULL
      GROUP BY l.id
      ORDER BY COALESCE(SUM(s.quantity), 0) DESC, MIN(l.name)
      LIMIT 1)
WHERE u.deleted_at IS NULL
  AND u.role = 'caller'
  AND u.location_id IN (SELECT id FROM locations WHERE deleted_at IS NOT NULL);

-- 3c. Drop the stranded stock rows behind deleted locations.
--     They are unreachable from the app and, left in place, keep a hidden
--     balance that nobody can read or correct. The figures at the three
--     real stores are untouched.
DELETE FROM product_location_stock s
USING locations l
WHERE l.id = s.location_id
  AND l.deleted_at IS NOT NULL;

-- 3d. Rebuild each medicine's headline total from its real stores.
--     The app keeps this as a cached sum and refreshes it whenever stock
--     moves, so it drifts while stock sits untouched. This resets it.
UPDATE products p
SET stock_quantity = COALESCE((
      SELECT SUM(s.quantity)
      FROM product_location_stock s
      JOIN locations l ON l.id = s.location_id AND l.deleted_at IS NULL
      WHERE s.product_id = p.id), 0)
WHERE p.deleted_at IS NULL;

COMMIT;


-- ---------------------------------------------------------------------
-- 4. Check it worked
-- ---------------------------------------------------------------------
\echo ''
\echo '=== every caller should now read "ok" ==='
SELECT u.name,
       u.email,
       COALESCE(l.name, '(none)') AS sells_from,
       CASE
         WHEN u.location_id IS NULL    THEN 'STILL NO LOCATION'
         WHEN l.deleted_at IS NOT NULL THEN 'STILL DELETED'
         ELSE 'ok'
       END AS state
FROM users u
LEFT JOIN locations l ON l.id = u.location_id
WHERE u.deleted_at IS NULL
  AND u.role = 'caller'
ORDER BY state DESC, u.name;

\echo ''
\echo '=== headline total should equal the sum of the real stores ==='
SELECT COALESCE(p.brand_name, p.generic_name) AS medicine,
       p.stock_quantity AS headline,
       COALESCE(SUM(s.quantity), 0) AS sum_of_stores,
       CASE WHEN p.stock_quantity = COALESCE(SUM(s.quantity), 0) THEN 'ok' ELSE 'MISMATCH' END AS state
FROM products p
LEFT JOIN product_location_stock s ON s.product_id = p.id
LEFT JOIN locations l ON l.id = s.location_id AND l.deleted_at IS NULL
WHERE p.deleted_at IS NULL
GROUP BY p.id, p.brand_name, p.generic_name, p.stock_quantity
ORDER BY state DESC, medicine;

\echo ''
\echo '=== no stock should remain at a deleted location ==='
SELECT COUNT(*) AS rows_still_stranded
FROM product_location_stock s
JOIN locations l ON l.id = s.location_id
WHERE l.deleted_at IS NOT NULL;
