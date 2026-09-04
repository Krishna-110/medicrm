-- ============================================================================
--  Delete one order (soft) — the order, its line items, and any renewal it opened.
--
--  The app has no delete-order action by design; every read filters on
--  deleted_at IS NULL, so setting that column makes the order disappear from the
--  UI while the row (and its audit trail) stays recoverable.
--
--  Set the order number below, then run:
--    psql -U postgres -d crmdb -v ON_ERROR_STOP=1 -f delete-order.sql
--
--  Repeat for each order you want gone. Runs as one transaction.
-- ============================================================================

\set order_number 'ORD-2026-0002'

BEGIN;

-- Show what will be removed, so it is on the record before it happens.
\echo 'About to soft-delete:'
SELECT o.order_number, o.customer_name, o.total_amount, o.stage,
       (SELECT count(*) FROM order_items i WHERE i.order_id = o.id AND i.deleted_at IS NULL) AS items,
       (SELECT count(*) FROM renewals r  WHERE r.order_id = o.id AND r.deleted_at IS NULL) AS renewals
FROM orders o
WHERE o.order_number = :'order_number' AND o.deleted_at IS NULL;

-- The renewal(s) this order opened.
UPDATE renewals
SET deleted_at = now()
WHERE deleted_at IS NULL
  AND order_id = (SELECT id FROM orders WHERE order_number = :'order_number' AND deleted_at IS NULL);

-- The order's line items.
UPDATE order_items
SET deleted_at = now()
WHERE deleted_at IS NULL
  AND order_id = (SELECT id FROM orders WHERE order_number = :'order_number' AND deleted_at IS NULL);

-- The order itself.
UPDATE orders
SET deleted_at = now()
WHERE deleted_at IS NULL
  AND order_number = :'order_number';

COMMIT;

\echo 'Done. Confirm it is gone (expect zero rows):'
SELECT order_number FROM orders
WHERE order_number = :'order_number' AND deleted_at IS NULL;
