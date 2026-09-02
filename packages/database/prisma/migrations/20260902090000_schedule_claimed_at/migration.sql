-- A claimed schedule now records when the claim was taken, so a claim left
-- behind by a restart can be told apart from a run that is still going.
ALTER TABLE "schedules" ADD COLUMN "claimedAt" TIMESTAMP(3);

-- Claims already in the database were taken by a build that released them on
-- one path only, so anything still holding one has been stuck since it took it.
UPDATE "schedules" SET "isProcessing" = false WHERE "isProcessing" = true;
