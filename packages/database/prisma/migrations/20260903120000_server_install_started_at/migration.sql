-- When the current install attempt started. A run whose worker died left the
-- server reading INSTALLING with nothing coming and no way to ask for another
-- one; housekeeping can now tell that apart from an install still in progress.
ALTER TABLE "servers" ADD COLUMN "installStartedAt" TIMESTAMP(3);
