-- ============================================================================
--  Abhyasa CRM — is the DATABASE missing columns, or is the Prisma client stale?
--
--  READ ONLY. Changes nothing. Safe to run on production at any time.
--
--  Run against the database the API actually uses:
--    psql -U postgres -d crmdb -f diagnose-schema.sql
--
--  Read the VERDICT at the bottom.
-- ============================================================================

\echo ''
\echo '=== 1. Do the columns the new code needs actually exist? ==='

SELECT
  expected.table_name,
  expected.column_name,
  CASE WHEN c.column_name IS NULL THEN 'MISSING  <-- database is behind'
       ELSE 'present' END AS status
FROM (VALUES
        ('follow_ups', 'completed_at'),   -- dashboard: Calls Done Today
        ('follow_ups', 'slot'),           -- follow-up time slot
        ('orders',     'payment_mode'),   -- online / offline sale
        ('leads',      'converted_at')    -- customers converted
     ) AS expected(table_name, column_name)
LEFT JOIN information_schema.columns c
       ON c.table_schema = 'public'
      AND c.table_name   = expected.table_name
      AND c.column_name  = expected.column_name
ORDER BY expected.table_name, expected.column_name;

\echo ''
\echo '=== 2. Which migrations does Prisma believe it has applied? ==='

SELECT migration_name,
       to_char(finished_at, 'YYYY-MM-DD HH24:MI') AS finished,
       CASE WHEN rolled_back_at IS NOT NULL THEN 'ROLLED BACK'
            WHEN finished_at IS NULL THEN 'NOT FINISHED'
            ELSE 'ok' END AS state
FROM _prisma_migrations
ORDER BY started_at;

\echo ''
\echo '=== VERDICT ==='

SELECT CASE
  WHEN COUNT(*) FILTER (WHERE c.column_name IS NULL) = 0
    THEN 'ALL COLUMNS PRESENT -> the database is FINE. The Prisma client is stale. '
      || 'Fix: run "npx prisma generate" in the folder the API runs from, then RESTART it. '
      || 'Adding columns will NOT help.'
  ELSE 'COLUMNS ARE MISSING -> the database is behind. '
      || 'Fix: run "npx prisma migrate deploy" in the folder the API runs from, then restart.'
  END AS verdict
FROM (VALUES
        ('follow_ups', 'completed_at'),
        ('follow_ups', 'slot'),
        ('orders',     'payment_mode'),
        ('leads',      'converted_at')
     ) AS expected(table_name, column_name)
LEFT JOIN information_schema.columns c
       ON c.table_schema = 'public'
      AND c.table_name   = expected.table_name
      AND c.column_name  = expected.column_name;

\echo ''
