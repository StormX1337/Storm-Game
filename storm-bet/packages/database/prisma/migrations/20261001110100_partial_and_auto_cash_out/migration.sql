-- AlterTable
ALTER TABLE "bets" ADD COLUMN     "auto_cashout_amount" BIGINT,
ADD COLUMN     "cashed_out_stake" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "bet_cashouts" (
    "id" UUID NOT NULL,
    "bet_id" UUID NOT NULL,
    "stake" BIGINT NOT NULL,
    "amount" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bet_cashouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bet_cashouts_bet_id_idx" ON "bet_cashouts"("bet_id");

-- AddForeignKey
ALTER TABLE "bet_cashouts" ADD CONSTRAINT "bet_cashouts_bet_id_fkey" FOREIGN KEY ("bet_id") REFERENCES "bets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Guards ─────────────────────────────────────────────────────────────────

-- Some stake always stays open: closing all of it is a full cashout.
ALTER TABLE "bets"
  ADD CONSTRAINT "bets_cashed_out_stake_valid" CHECK ("cashed_out_stake" >= 0 AND "cashed_out_stake" < "stake"),
  ADD CONSTRAINT "bets_auto_cashout_positive" CHECK ("auto_cashout_amount" IS NULL OR "auto_cashout_amount" > 0);

ALTER TABLE "bet_cashouts"
  ADD CONSTRAINT "bet_cashouts_stake_positive" CHECK ("stake" > 0),
  ADD CONSTRAINT "bet_cashouts_amount_positive" CHECK ("amount" > 0);

CREATE TRIGGER "bet_cashouts_append_only" BEFORE UPDATE OR DELETE ON "bet_cashouts"
  FOR EACH ROW EXECUTE FUNCTION "storm_reject_mutation"();
CREATE TRIGGER "bet_cashouts_no_truncate" BEFORE TRUNCATE ON "bet_cashouts"
  FOR EACH STATEMENT EXECUTE FUNCTION "storm_reject_mutation"();

-- Settled bets stay final; a closed stake part never reopens.
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
    OR NEW."reference" <> OLD."reference" THEN
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
