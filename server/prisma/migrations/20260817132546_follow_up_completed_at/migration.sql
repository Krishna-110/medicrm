-- AlterTable
ALTER TABLE "follow_ups" ADD COLUMN     "completed_at" TIMESTAMP(3);

-- Backfill the calls already made, which carry no recorded moment.
--
-- updated_at is the closest evidence there is: for a completed follow-up the status change is
-- the last thing that happened to the row, or near enough. scheduled_at is deliberately not
-- used — that is when the call was meant to happen, which is exactly the confusion this
-- column exists to end.
UPDATE "follow_ups"
SET "completed_at" = "updated_at"
WHERE "status" = 'completed' AND "completed_at" IS NULL;

-- CreateIndex
CREATE INDEX "follow_ups_completed_at_idx" ON "follow_ups"("completed_at");
