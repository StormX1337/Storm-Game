-- A webhook the panel switched off itself now records when, and what it was
-- failing on, so an operator finding it inactive is not left guessing.
ALTER TABLE "webhooks" ADD COLUMN "disabledAt" TIMESTAMP(3);
ALTER TABLE "webhooks" ADD COLUMN "disabledReason" TEXT;
