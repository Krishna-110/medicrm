-- ============================================================================
--  Abhyasa CRM — reset production to a clean slate
--  Run against the PRODUCTION database (crmdb) on the CRM server.
--
--  KEEPS   the medicine catalogue, prices, locations and per-location stock,
--          plus two accounts:
--            admin@gmail.com            (Admin, password reset to admin123)
--            mohitdeshwal27@gmail.com   (Mr. Mohit, Caller)
--
--  DELETES every lead, order, renewal, follow-up, customer, activity,
--          assignment, notification and audit row, every other user account,
--          and all sessions.
--
--  This cannot be undone. Take a backup first:
--    pg_dump -U postgres -d crmdb -F c -f crmdb-before-reset.dump
--
--  Runs as one transaction: it either all applies or none of it does.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Business data, children before parents so no foreign key is left dangling.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 2. Everyone signs in again — including the two accounts being kept, whose
--    tokens would otherwise still be valid.
-- ---------------------------------------------------------------------------
DELETE FROM sessions;

-- ---------------------------------------------------------------------------
-- 3. Every account except the two named. Safe only because step 1 has already
--    removed everything that referenced them.
-- ---------------------------------------------------------------------------
DELETE FROM users
WHERE lower(email) NOT IN ('admin@gmail.com', 'mohitdeshwal27@gmail.com');

-- ---------------------------------------------------------------------------
-- 4. The admin account: password admin123, active, and admin.
--    Inserted if it is somehow absent, so this script also works on a database
--    that never had it.
-- ---------------------------------------------------------------------------
INSERT INTO users (id, employee_id, name, phone, email, password_hash, role, status,
                   assigned_leads_count, created_at, updated_at)
VALUES (gen_random_uuid(), 'ADM001', 'Admin', '0000000000', 'admin@gmail.com',
        '$2b$10$WLFgs7URzufks6TacDv5R.ojslizKGeknDIQQMjrweCVIx7u5K.xa', 'admin', 'active', 0, now(), now())
ON CONFLICT (email) DO UPDATE
   SET password_hash = EXCLUDED.password_hash,
       role          = 'admin',
       status        = 'active',
       deleted_at    = NULL,
       updated_at    = now();

-- ---------------------------------------------------------------------------
-- 5. The lead counter is denormalised, so it has to be told the leads are gone.
--    Mr. Mohit showed 2; both of those leads no longer exist.
-- ---------------------------------------------------------------------------
UPDATE users SET assigned_leads_count = 0;

-- ---------------------------------------------------------------------------
-- 6. Order numbers restart at ORD-<year>-0001. The sequence is independent of
--    the rows, so deleting the orders does not rewind it.
-- ---------------------------------------------------------------------------
ALTER SEQUENCE order_number_seq RESTART WITH 1;

COMMIT;

-- ---------------------------------------------------------------------------
-- Check. Expect: 2 users, 0 across every business table, stock untouched.
-- ---------------------------------------------------------------------------
SELECT 'users'      AS table, count(*) FROM users
UNION ALL SELECT 'leads',        count(*) FROM leads
UNION ALL SELECT 'orders',       count(*) FROM orders
UNION ALL SELECT 'renewals',     count(*) FROM renewals
UNION ALL SELECT 'follow_ups',   count(*) FROM follow_ups
UNION ALL SELECT 'customers',    count(*) FROM customers
UNION ALL SELECT 'sessions',     count(*) FROM sessions
UNION ALL SELECT 'products KEPT',   count(*) FROM products
UNION ALL SELECT 'locations KEPT',  count(*) FROM locations
UNION ALL SELECT 'stock rows KEPT', count(*) FROM product_location_stock
UNION ALL SELECT 'stock units KEPT', coalesce(sum(quantity),0) FROM product_location_stock;

SELECT email, name, role, status FROM users ORDER BY role;
