-- Slots became two-hour windows across the 10–6 calling day, replacing the three
-- part-of-day buckets the column shipped with.
--
-- The old names have no exact equivalent, so each is carried to the window it starts in
-- rather than being guessed at more precisely than the conversation ever was. Anything
-- unrecognised is cleared to NULL — "any time" — because a slot the app cannot offer is
-- worse than no slot: the dropdown would silently show blank and save over it.
UPDATE "follow_ups" SET "slot" = '10-12' WHERE "slot" = 'morning';
UPDATE "follow_ups" SET "slot" = '12-14' WHERE "slot" = 'afternoon';
UPDATE "follow_ups" SET "slot" = '16-18' WHERE "slot" = 'evening';
UPDATE "follow_ups" SET "slot" = NULL
WHERE "slot" IS NOT NULL AND "slot" NOT IN ('10-12', '12-14', '14-16', '16-18');
