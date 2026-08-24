-- 'sold' is no longer a conversion, so the dates stamped on those leads must go.
--
-- The status is a label a caller picks from the dropdown: it raises no order, moves no stock
-- and opens no renewal. It was dated back when marking a lead sold still demanded payment
-- proof, which made it a plausible stand-in for a sale; that requirement was removed, so the
-- status now evidences nothing and a date on it is a claim the data cannot support.
--
-- Leaving these in place would keep Total Customers ahead of Total Orders with no way to
-- reconcile the two, and keep people in the customer list who never bought anything —
-- which is the whole reason for the change.
--
-- Only 'sold' is touched. 'converted' is written solely by the conversion transaction, which
-- raises the order in the same breath, so those dates are real and stay.
UPDATE "leads"
SET "converted_at" = NULL
WHERE "status" = 'sold' AND "converted_at" IS NOT NULL;
