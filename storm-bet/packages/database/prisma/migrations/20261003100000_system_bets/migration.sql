-- System bets: every combination of k out of n selections, one stake per combination.
ALTER TYPE "BetType" ADD VALUE 'SYSTEM';
ALTER TYPE "SlipMode" ADD VALUE 'SYSTEM';

ALTER TABLE "bets" ADD COLUMN "system_size" INTEGER;
-- Only a system bet has a combination size; it is at least 2.
ALTER TABLE "bets" ADD CONSTRAINT "bets_system_size_valid" CHECK (
  ("type"::text = 'SYSTEM') = ("system_size" IS NOT NULL) AND ("system_size" IS NULL OR "system_size" >= 2)
);

-- The combination size (and a boost) are terms of the bet like its stake and odds.
CREATE OR REPLACE FUNCTION "storm_guard_bet"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bets cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'bet % is settled (%) and cannot be changed', OLD."id", OLD."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."user_id" <> OLD."user_id" OR NEW."slip_id" <> OLD."slip_id" OR NEW."type" <> OLD."type"
    OR NEW."stake" <> OLD."stake" OR NEW."total_odds" <> OLD."total_odds"
    OR NEW."potential_return" <> OLD."potential_return" OR NEW."placed_at" <> OLD."placed_at"
    OR NEW."reference" <> OLD."reference"
    OR NEW."system_size" IS DISTINCT FROM OLD."system_size"
    OR NEW."boost_id" IS DISTINCT FROM OLD."boost_id" THEN
    RAISE EXCEPTION 'the terms of bet % are fixed at placement', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."cashed_out_stake" < OLD."cashed_out_stake" THEN
    RAISE EXCEPTION 'a cashed-out part of bet % cannot be reopened', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
