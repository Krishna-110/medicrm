-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "converted_at" TIMESTAMP(3);

-- Backfill leads that already sold, which have no recorded moment of conversion.
--
-- A conversion writes its order in the same transaction as the status change, so the
-- earliest order for the lead IS that moment — exact, not an estimate. A lead marked sold
-- by hand raised no order, so updated_at stands in: it is when the row last changed, which
-- for those leads is the status change itself or something shortly after. created_at is
-- deliberately not the fallback — capture can precede the sale by months.
UPDATE "leads" l
SET "converted_at" = COALESCE(
  (SELECT MIN(o."created_at") FROM "orders" o WHERE o."lead_id" = l."id"),
  l."updated_at"
)
WHERE l."status" IN ('converted', 'sold')
  AND l."converted_at" IS NULL;

-- Reading "customers converted this week" scans on this.
CREATE INDEX "leads_converted_at_idx" ON "leads"("converted_at");
