-- =====================================================================
--  Wipe the CRM back to a clean slate
-- =====================================================================
--
--  WHAT IT KEEPS
--    * the single user admin@gmail.com (password unchanged)
--    * the medicine catalogue MED-101 .. MED-118 (names and prices as-is)
--    * the three stores: Samalkha, Shamli, Madlauda
--    * the dropdown lookup tables the app needs to boot
--
--  WHAT IT DESTROYS -- permanently, no undo
--    * every other user, including every caller
--    * every lead, customer, order, renewal, follow-up, notification
--    * the whole audit log
--    * every other location (this is what finally kills "Main Store")
--    * the seven demo medicines MED-001 .. MED-007
--
--  THEN it writes the stock sheet below and resets order numbering to
--  ORD-<year>-0001.
--
--  AFTER IT RUNS there are no callers left, and a sale always leaves the
--  caller's own store -- so nobody can convert a lead until you add the
--  callers back and give each one a store.
--
--  TAKE A BACKUP FIRST:
--    & "C:\Program Files\PostgreSQL\<version>\bin\pg_dump.exe" -U postgres -d crmdb -f "crmdb-before-reset.sql"
--
--  HOW TO RUN  (normal PowerShell on the server; set <version> to whatever
--  folder is actually under C:\Program Files\PostgreSQL)
--    $env:PGPASSWORD='<password>'
--    & "C:\Program Files\PostgreSQL\<version>\bin\psql.exe" -U postgres -d crmdb -v ON_ERROR_STOP=1 -f reset-to-clean-slate.sql
--
--  Everything is one transaction. If any statement fails -- including the
--  safety checks in step 1 -- nothing at all is applied.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Safety checks. These run FIRST and abort the whole thing.
-- ---------------------------------------------------------------------
--    Each one casts a message to int when the check fails, so psql stops
--    with the message itself in the error rather than a bare failure. The
--    message has COUNT(*) concatenated into it deliberately: a message made
--    only of literals is folded away and evaluated while the query is still
--    being planned, which fires the abort even when the check passes.

-- Refuse to run if the account we are meant to keep is not there, which
-- would otherwise leave the system with no way to log in.
SELECT CASE WHEN COUNT(*) = 1 THEN 0
            ELSE CAST('ABORT: no live user admin@gmail.com -- found ' || COUNT(*) AS int) END
FROM users WHERE email = 'admin@gmail.com' AND deleted_at IS NULL;

-- Refuse to run unless each store name matches exactly one live location.
SELECT CASE WHEN COUNT(*) = 1 THEN 0
            ELSE CAST('ABORT: Samalkha store must match exactly one location -- matched ' || COUNT(*) AS int) END
FROM locations WHERE name LIKE 'Samalkha%' AND deleted_at IS NULL;

SELECT CASE WHEN COUNT(*) = 1 THEN 0
            ELSE CAST('ABORT: Shamli store must match exactly one location -- matched ' || COUNT(*) AS int) END
FROM locations WHERE name LIKE 'Shamli%' AND deleted_at IS NULL;

SELECT CASE WHEN COUNT(*) = 1 THEN 0
            ELSE CAST('ABORT: Madlauda store must match exactly one location -- matched ' || COUNT(*) AS int) END
FROM locations WHERE name LIKE 'Madlauda%' AND deleted_at IS NULL;

-- Refuse to run unless all 18 medicines are present to receive stock.
SELECT CASE WHEN COUNT(*) = 18 THEN 0
            ELSE CAST('ABORT: expected 18 medicines MED-101..MED-118 -- found ' || COUNT(*) AS int) END
FROM products WHERE sku BETWEEN 'MED-101' AND 'MED-118';


-- ---------------------------------------------------------------------
-- 2. Clear the working data, children before parents
-- ---------------------------------------------------------------------
DELETE FROM audit_log;
DELETE FROM notifications;
DELETE FROM follow_ups;
DELETE FROM renewals;
DELETE FROM order_items;
DELETE FROM orders;
DELETE FROM lead_activities;
DELETE FROM lead_assignments;
DELETE FROM lead_medicines;
DELETE FROM leads;
DELETE FROM customers;

-- Logs everyone out, including the admin -- they sign in again after this.
DELETE FROM sessions;


-- ---------------------------------------------------------------------
-- 3. Everyone except the admin
-- ---------------------------------------------------------------------
DELETE FROM users WHERE email <> 'admin@gmail.com';


-- ---------------------------------------------------------------------
-- 4. Catalogue and stores
-- ---------------------------------------------------------------------
-- Stock rows go first: they point at both of the tables below.
DELETE FROM product_location_stock;

-- The seven demo medicines that shipped with the system (Metformin,
-- Amlodipine, Atorvastatin, Insulin Glargine, Levothyroxine, Azithromycin,
-- Paracetamol). Named one by one on purpose: anything else in the
-- catalogue is something you added, so it is left alone -- it just ends up
-- with no stock, since the sheet below only covers MED-101..MED-118.
DELETE FROM products WHERE sku BETWEEN 'MED-001' AND 'MED-007';

-- Every location that is not one of the three real stores. "Main Store"
-- dies here, which is what stops sales draining into a store nobody can
-- see. Safe now: no user or stock row still points at one.
DELETE FROM locations
WHERE name NOT LIKE 'Samalkha%'
  AND name NOT LIKE 'Shamli%'
  AND name NOT LIKE 'Madlauda%';

-- A sale always leaves the seller's own location, so the admin needs one.
UPDATE users
SET location_id = (SELECT id FROM locations WHERE name LIKE 'Samalkha%' AND deleted_at IS NULL)
WHERE email = 'admin@gmail.com';


-- ---------------------------------------------------------------------
-- 5. The stock sheet
-- ---------------------------------------------------------------------
--   Read it as the table it is: one medicine per line, then what sits at
--   Samalkha, Shamli and Madlauda. Edit a number here and re-run the file
--   to correct it.

INSERT INTO product_location_stock (id, product_id, location_id, quantity, created_at, updated_at)
SELECT gen_random_uuid(), p.id, l.id, s.qty, now(), now()
FROM (VALUES
  --   sku                                   Samalkha  Shamli  Madlauda
  ('MED-101',  -- Tejasvi Ark
                                                   40,      8,       14),
  ('MED-102',  -- Tejasvi Kadha
                                                   40,      8,       14),
  ('MED-103',  -- Vedic Shiv Amrit Ark
                                                   35,     10,       10),
  ('MED-104',  -- Vedic Shiv Amrit Syrup
                                                   35,     10,       10),
  ('MED-105',  -- Anus Care 1
                                                   22,      4,        6),
  ('MED-106',  -- Anus Care 2
                                                   22,     18,        6),
  ('MED-107',  -- Anus Care Cream
                                                   15,      3,        2),
  ('MED-108',  -- Kamaking Capsule
                                                   80,      4,        8),
  ('MED-109',  -- Kamaking Oil
                                                   15,      3,        2),
  ('MED-110',  -- Asthma Powder
                                                  220,     12,       10),
  ('MED-111',  -- Asthma Tab
                                                   80,     12,       10),
  ('MED-112',  -- Ashwashila Malt
                                                   90,      5,        3),
  ('MED-113',  -- Weight Gain Powder
                                                   32,      5,        3),
  ('MED-114',  -- Weight Loss Powder
                                                   50,      6,        3),
  ('MED-115',  -- Kidney Kaya Syrup
                                                   40,      4,       10),
  ('MED-116',  -- Lady Gold Ark
                                                   30,      9,       10),
  ('MED-117',  -- Sansamrit
                                                   20,      8,        8),
  ('MED-118',  -- Dardantak Powder
                                                  116,      6,       10)
) AS v(sku, samalkha, shamli, madlauda)
-- Turn each row's three columns into three stock rows.
CROSS JOIN LATERAL (VALUES ('Samalkha', v.samalkha),
                           ('Shamli',   v.shamli),
                           ('Madlauda', v.madlauda)) AS s(store, qty)
JOIN products  p ON p.sku = v.sku
JOIN locations l ON l.name LIKE s.store || '%' AND l.deleted_at IS NULL;


-- ---------------------------------------------------------------------
-- 6. Headline totals and order numbering
-- ---------------------------------------------------------------------
-- products.stock_quantity is a cached sum of the rows above, so it has to
-- be rewritten whenever they are.
UPDATE products p
SET stock_quantity = COALESCE((SELECT SUM(s.quantity)
                               FROM product_location_stock s
                               WHERE s.product_id = p.id), 0);

-- Next conversion becomes ORD-<year>-0001 again.
ALTER SEQUENCE order_number_seq RESTART WITH 1;

COMMIT;


-- ---------------------------------------------------------------------
-- 7. Check it worked
-- ---------------------------------------------------------------------
SELECT 'users left'    AS what, COUNT(*)::text AS value FROM users
UNION ALL SELECT 'leads',       COUNT(*)::text FROM leads
UNION ALL SELECT 'customers',   COUNT(*)::text FROM customers
UNION ALL SELECT 'orders',      COUNT(*)::text FROM orders
UNION ALL SELECT 'renewals',    COUNT(*)::text FROM renewals
UNION ALL SELECT 'follow-ups',  COUNT(*)::text FROM follow_ups
UNION ALL SELECT 'locations',   COUNT(*)::text FROM locations
UNION ALL SELECT 'medicines',   COUNT(*)::text FROM products
UNION ALL SELECT 'total units', COALESCE(SUM(quantity),0)::text FROM product_location_stock;

SELECT l.name AS store, COALESCE(SUM(s.quantity), 0) AS units
FROM locations l
LEFT JOIN product_location_stock s ON s.location_id = l.id
GROUP BY l.name
ORDER BY l.name;

SELECT p.sku,
       COALESCE(p.brand_name, p.generic_name) AS medicine,
       MAX(CASE WHEN l.name LIKE 'Samalkha%' THEN s.quantity END) AS samalkha,
       MAX(CASE WHEN l.name LIKE 'Shamli%'   THEN s.quantity END) AS shamli,
       MAX(CASE WHEN l.name LIKE 'Madlauda%' THEN s.quantity END) AS madlauda,
       p.stock_quantity AS headline
FROM products p
LEFT JOIN product_location_stock s ON s.product_id = p.id
LEFT JOIN locations l ON l.id = s.location_id
GROUP BY p.id, p.sku, p.brand_name, p.generic_name, p.stock_quantity
ORDER BY p.sku;
