-- ============================================================================
-- MediCRM: Production Database Reset & Stock Initialization Script
-- ============================================================================
-- PURPOSE:
--   1. Purges all test/scratch transactions (leads, customers, orders, renewals,
--      follow-ups, notifications, audit logs, sessions, and non-admin test callers).
--   2. Preserves existing admin user credentials (ID, email, name, password_hash).
--   3. Removes "Main Store" and configures the 3 official stores:
--      - Madlauda
--      - Shamli
--      - Samalkha
--   4. Updates the 18 Ayurvedic products with new catalogue prices.
--   5. Populates exact physical inventory for Madlauda, Shamli, and Samalkha (1,256 total units).
--   6. Restarts order-number sequence to 1 (ORD-YYYY-0001).
-- ============================================================================

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

-- 2. Keep admin user ID & password intact; delete test callers
DELETE FROM "users" WHERE "role" != 'admin';
UPDATE "users"
SET "assigned_leads_count" = 0,
    "last_login_at" = NULL
WHERE "role" = 'admin';

-- 3. Clear existing stock associations
DELETE FROM "product_location_stock";

-- 4. Delete demo medicines MED-001..MED-007 if present
DELETE FROM "products" WHERE "sku" BETWEEN 'MED-001' AND 'MED-007';

-- 5. Upsert the 3 official stores (Madlauda, Shamli, Samalkha)
INSERT INTO "locations" ("id", "name", "created_at", "updated_at")
VALUES
  (gen_random_uuid(), 'Madlauda', now(), now()),
  (gen_random_uuid(), 'Shamli', now(), now()),
  (gen_random_uuid(), 'Samalkha', now(), now())
ON CONFLICT ("name") DO UPDATE
  SET "deleted_at" = NULL, "updated_at" = now();

-- 6. Unassign any other locations from users & delete them (kills "Main Store")
UPDATE "users"
SET "location_id" = NULL
WHERE "location_id" IN (
  SELECT "id" FROM "locations"
  WHERE "name" NOT IN ('Madlauda', 'Shamli', 'Samalkha')
);

DELETE FROM "locations"
WHERE "name" NOT IN ('Madlauda', 'Shamli', 'Samalkha');

-- 7. Upsert the 18 Ayurvedic products with updated production prices
INSERT INTO "products" ("id", "sku", "generic_name", "brand_name", "dosage_form", "unit_price", "stock_quantity", "is_active", "created_at", "updated_at")
VALUES
  (gen_random_uuid(), 'MED-101', 'Tejasvi Ark', 'Tejasvi Ark', 'other', 600, 0, true, now(), now()),
  (gen_random_uuid(), 'MED-102', 'Tejasvi Kadha', 'Tejasvi Kadha', 'other', 600, 0, true, now(), now()),
  (gen_random_uuid(), 'MED-103', 'Vedic Shiv Amrit Ark', 'Vedic Shiv Amrit Ark', 'other', 600, 0, true, now(), now()),
  (gen_random_uuid(), 'MED-104', 'Vedic Shiv Amrit Syrup', 'Vedic Shiv Amrit Syrup', 'syrup', 600, 0, true, now(), now()),
  (gen_random_uuid(), 'MED-105', 'Anus Care 1', 'Anus Care 1', 'other', 600, 0, true, now(), now()),
  (gen_random_uuid(), 'MED-106', 'Anus Care 2', 'Anus Care 2', 'other', 600, 0, true, now(), now()),
  (gen_random_uuid(), 'MED-107', 'Anus Care Cream', 'Anus Care Cream', 'other', 300, 0, true, now(), now()),
  (gen_random_uuid(), 'MED-108', 'Kamaking Capsule', 'Kamaking Capsule', 'capsule', 1500, 0, true, now(), now()),
  (gen_random_uuid(), 'MED-109', 'Kamaking Oil', 'Kamaking Oil', 'other', 500, 0, true, now(), now()),
  (gen_random_uuid(), 'MED-110', 'Asthma Powder', 'Asthma Powder', 'other', 800, 0, true, now(), now()),
  (gen_random_uuid(), 'MED-111', 'Asthma Tab', 'Asthma Tab', 'tablet', 800, 0, true, now(), now()),
  (gen_random_uuid(), 'MED-112', 'Ashwashila Malt', 'Ashwashila Malt', 'other', 2500, 0, true, now(), now()),
  (gen_random_uuid(), 'MED-113', 'Weight Gain Powder', 'Weight Gain Powder', 'other', 1500, 0, true, now(), now()),
  (gen_random_uuid(), 'MED-114', 'Weight Loss Powder', 'Weight Loss Powder', 'other', 1000, 0, true, now(), now()),
  (gen_random_uuid(), 'MED-115', 'Kidney Kaya Syrup', 'Kidney Kaya Syrup', 'syrup', 800, 0, true, now(), now()),
  (gen_random_uuid(), 'MED-116', 'Lady Gold Ark', 'Lady Gold Ark', 'other', 800, 0, true, now(), now()),
  (gen_random_uuid(), 'MED-117', 'Sansamrit', 'Sansamrit', 'other', 800, 0, true, now(), now()),
  (gen_random_uuid(), 'MED-118', 'Dardantak Powder', 'Dardantak Powder', 'other', 800, 0, true, now(), now())
ON CONFLICT ("sku") DO UPDATE
  SET "unit_price" = EXCLUDED."unit_price",
      "generic_name" = EXCLUDED."generic_name",
      "brand_name" = EXCLUDED."brand_name",
      "is_active" = true,
      "deleted_at" = NULL,
      "updated_at" = now();

-- 8. Populate exact inventory for Madlauda, Shamli, and Samalkha
INSERT INTO "product_location_stock" ("id", "product_id", "location_id", "quantity", "created_at", "updated_at")
SELECT gen_random_uuid(), p.id, l.id, s.qty, now(), now()
FROM (VALUES
  -- sku      Madlauda  Shamli  Samalkha
  ('MED-101',       14,      8,       40), -- Tejasvi Ark
  ('MED-102',       14,      8,       40), -- Tejasvi Kadha
  ('MED-103',       10,     10,       35), -- Vedic Shiv Amrit Ark
  ('MED-104',       10,     10,       35), -- Vedic Shiv Amrit Syrup
  ('MED-105',        6,      4,       22), -- Anus Care 1
  ('MED-106',        6,     18,       22), -- Anus Care 2
  ('MED-107',        2,      3,       15), -- Anus Care Cream
  ('MED-108',        8,      4,       80), -- Kamaking Capsule
  ('MED-109',        2,      3,       15), -- Kamaking Oil
  ('MED-110',       10,     12,      220), -- Asthma Powder
  ('MED-111',       10,     12,       80), -- Asthma Tab
  ('MED-112',        3,      5,       90), -- Ashwashila Malt
  ('MED-113',        3,      5,       32), -- Weight Gain Powder
  ('MED-114',        3,      6,       50), -- Weight Loss Powder
  ('MED-115',       10,      4,       40), -- Kidney Kaya Syrup
  ('MED-116',       10,      9,       30), -- Lady Gold Ark
  ('MED-117',        8,      8,       20), -- Sansamrit
  ('MED-118',       10,      6,      116)  -- Dardantak Powder
) AS v(sku, madlauda, shamli, samalkha)
CROSS JOIN LATERAL (VALUES
  ('Madlauda', v.madlauda),
  ('Shamli',   v.shamli),
  ('Samalkha', v.samalkha)
) AS s(store, qty)
JOIN "products" p ON p."sku" = v.sku
JOIN "locations" l ON l."name" = s.store AND l."deleted_at" IS NULL;

-- 9. Recompute headline stock_quantity on products table
UPDATE "products" p
SET "stock_quantity" = COALESCE((
  SELECT SUM(s."quantity")
  FROM "product_location_stock" s
  WHERE s."product_id" = p."id"
), 0),
"updated_at" = now();

-- 10. Restart order numbering at ORD-YYYY-0001
ALTER SEQUENCE IF EXISTS order_number_seq RESTART WITH 1;

COMMIT;

-- ============================================================================
-- VERIFICATION REPORT
-- ============================================================================
SELECT 'admin users kept' AS metric, count(*)::text AS val FROM users WHERE role = 'admin'
UNION ALL SELECT 'callers remaining', count(*)::text FROM users WHERE role != 'admin'
UNION ALL SELECT 'leads', count(*)::text FROM leads
UNION ALL SELECT 'orders', count(*)::text FROM orders
UNION ALL SELECT 'customers', count(*)::text FROM customers
UNION ALL SELECT 'products (18)', count(*)::text FROM products WHERE sku BETWEEN 'MED-101' AND 'MED-118'
UNION ALL SELECT 'stores (3)', count(*)::text FROM locations
UNION ALL SELECT 'total stock units (1256)', coalesce(sum(quantity),0)::text FROM product_location_stock;

SELECT l.name AS store, coalesce(sum(s.quantity), 0) AS total_units
FROM locations l
LEFT JOIN product_location_stock s ON s.location_id = l.id
GROUP BY l.name
ORDER BY l.name;

SELECT p.sku,
       coalesce(p.brand_name, p.generic_name) AS medicine,
       p.unit_price AS price,
       max(CASE WHEN l.name = 'Madlauda' THEN s.quantity ELSE 0 END) AS madlauda_stock,
       max(CASE WHEN l.name = 'Shamli'   THEN s.quantity ELSE 0 END) AS shamli_stock,
       max(CASE WHEN l.name = 'Samalkha' THEN s.quantity ELSE 0 END) AS samalkha_stock,
       p.stock_quantity AS total_stock
FROM products p
LEFT JOIN product_location_stock s ON s.product_id = p.id
LEFT JOIN locations l ON l.id = s.location_id
WHERE p.sku BETWEEN 'MED-101' AND 'MED-118'
GROUP BY p.id, p.sku, p.brand_name, p.generic_name, p.unit_price, p.stock_quantity
ORDER BY p.sku;
