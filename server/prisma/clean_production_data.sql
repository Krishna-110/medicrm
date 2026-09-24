-- ============================================================================
-- MediCRM: Production Database Cleanup Script
-- ============================================================================
-- PURPOSE:
--   Purges all test/scratch transactions (leads, customers, orders, renewals,
--   follow-ups, notifications, audit logs, sessions, and non-admin test callers)
--   for live production launch.
--
-- PRESERVED DATA:
--   ✓ Admin user credentials (ID, email, name, password_hash, role = 'admin')
--   ✓ All stock / catalogue items (products table)
--   ✓ All inventory locations & location stock (locations, product_location_stock)
--   ✓ System lookup tables (lead_statuses, lead_sources, order_stages, etc.)
--   ✓ Prisma migration history (_prisma_migrations)
--
-- RESET ACTIONS:
--   ✓ Resets assigned_leads_count to 0 on the admin user
--   ✓ Restarts order_number_seq to 1 (first production order will be ORD-YYYY-0001)
-- ============================================================================

BEGIN;

-- 1. Delete dependent items and history on leads & orders
DELETE FROM "lead_medicines";
DELETE FROM "lead_activities";
DELETE FROM "lead_assignments";
DELETE FROM "order_items";

-- 2. Delete follow-ups and renewals (must be deleted before orders & customers)
DELETE FROM "follow_ups";
DELETE FROM "renewals";

-- 3. Delete orders and leads
DELETE FROM "orders";
DELETE FROM "leads";

-- 4. Delete customers (now that no orders, leads, or renewals reference them)
DELETE FROM "customers";

-- 5. Delete activity logs, notifications, and auth sessions
DELETE FROM "notifications";
DELETE FROM "audit_log";
DELETE FROM "sessions";

-- 6. Delete test callers (keep only admin users)
DELETE FROM "users" WHERE "role" != 'admin';

-- 7. Reset lead assignment counters and login timestamp on remaining admin user(s)
UPDATE "users"
SET "assigned_leads_count" = 0,
    "last_login_at" = NULL
WHERE "role" = 'admin';

-- 8. Reset the order number sequence so production numbering starts fresh from 1
ALTER SEQUENCE IF EXISTS order_number_seq RESTART WITH 1;

COMMIT;

-- ============================================================================
-- VERIFICATION REPORT
-- ============================================================================
-- Run these checks to verify the clean state of the production database:

SELECT
  (SELECT count(*) FROM "users" WHERE "role" = 'admin') AS admin_users_kept,
  (SELECT count(*) FROM "users" WHERE "role" != 'admin') AS test_callers_remaining,
  (SELECT count(*) FROM "products")                     AS products_kept,
  (SELECT count(*) FROM "locations")                    AS locations_kept,
  (SELECT count(*) FROM "product_location_stock")       AS stock_records_kept,
  (SELECT count(*) FROM "leads")                        AS leads_count,
  (SELECT count(*) FROM "customers")                    AS customers_count,
  (SELECT count(*) FROM "orders")                       AS orders_count,
  (SELECT count(*) FROM "renewals")                     AS renewals_count,
  (SELECT count(*) FROM "follow_ups")                   AS follow_ups_count,
  (SELECT count(*) FROM "notifications")                AS notifications_count,
  (SELECT count(*) FROM "audit_log")                    AS audit_log_count,
  (SELECT count(*) FROM "sessions")                     AS sessions_count;
