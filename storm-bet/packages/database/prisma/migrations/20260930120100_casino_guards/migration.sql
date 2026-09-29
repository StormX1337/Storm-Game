-- Casino integrity rules. The enum values used here were committed by the
-- previous migration, so they are safe to reference.

-- Every ledger entry names what it belongs to: a bet, a casino round, or
-- nothing (demo credit).
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_bet_reference";
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_reference" CHECK (
  CASE
    WHEN "type" = 'DEPOSIT_DEMO' THEN "bet_id" IS NULL AND "casino_round_id" IS NULL
    WHEN "type" IN ('CASINO_BET', 'CASINO_WIN', 'CASINO_REFUND')
      THEN "bet_id" IS NULL AND "casino_round_id" IS NOT NULL
    ELSE "bet_id" IS NOT NULL AND "casino_round_id" IS NULL
  END
);

-- Casino stakes leave the balance, wins and refunds return to it; nothing is reserved.
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_casino_amounts" CHECK (
  "type" NOT IN ('CASINO_BET', 'CASINO_WIN', 'CASINO_REFUND')
  OR ("reserved_delta" = 0 AND (("type" = 'CASINO_BET' AND "amount" < 0)
                                OR ("type" <> 'CASINO_BET' AND "amount" > 0)))
);

-- A round pays out (win or refund) at most once.
CREATE UNIQUE INDEX "transactions_casino_payout_once"
  ON "transactions" ("casino_round_id")
  WHERE "type" IN ('CASINO_WIN', 'CASINO_REFUND');

ALTER TABLE "casino_rounds" ADD CONSTRAINT "casino_rounds_amounts"
  CHECK ("stake" > 0 AND "payout" >= 0 AND "step" >= 0);
ALTER TABLE "casino_games" ADD CONSTRAINT "casino_games_stakes"
  CHECK ("min_stake" > 0 AND "max_stake" >= "min_stake");

-- A payout entry must match the round's final state.
CREATE FUNCTION casino_ledger_guard() RETURNS trigger AS $$
DECLARE round_status text;
BEGIN
  IF NEW."type" IN ('CASINO_WIN', 'CASINO_REFUND') THEN
    SELECT "status"::text INTO round_status FROM "casino_rounds" WHERE "id" = NEW."casino_round_id";
    IF (NEW."type" = 'CASINO_WIN' AND round_status <> 'SETTLED')
      OR (NEW."type" = 'CASINO_REFUND' AND round_status <> 'REFUNDED') THEN
      RAISE EXCEPTION '% for casino round % in status %', NEW."type", NEW."casino_round_id", round_status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "transactions_casino_guard"
  BEFORE INSERT ON "transactions"
  FOR EACH ROW EXECUTE FUNCTION casino_ledger_guard();

-- Finished rounds are history: never changed, never deleted.
CREATE FUNCTION casino_round_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'casino rounds cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" <> 'OPEN' THEN
    RAISE EXCEPTION 'casino round % is closed', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."user_id" <> OLD."user_id" OR NEW."game_id" <> OLD."game_id"
    OR NEW."session_id" <> OLD."session_id" OR NEW."idempotency_key" <> OLD."idempotency_key"
    OR NEW."created_at" <> OLD."created_at" OR NEW."stake" < OLD."stake" THEN
    RAISE EXCEPTION 'casino round % identity cannot change', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "casino_rounds_guard"
  BEFORE UPDATE OR DELETE ON "casino_rounds"
  FOR EACH ROW EXECUTE FUNCTION casino_round_guard();
