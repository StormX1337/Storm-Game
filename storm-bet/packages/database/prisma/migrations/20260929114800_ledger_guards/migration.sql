-- Integrity rules the database enforces on its own, so that no bug, script or
-- manual query in any service can produce a negative wallet, a double payout
-- or a rewritten ledger.

-- ─── Value constraints ──────────────────────────────────────────────────────

ALTER TABLE "users" ADD CONSTRAINT "users_email_lowercase" CHECK ("email" = lower("email"));

ALTER TABLE "wallets"
  ADD CONSTRAINT "wallets_balance_non_negative" CHECK ("balance" >= 0),
  ADD CONSTRAINT "wallets_reserved_non_negative" CHECK ("reserved" >= 0),
  ADD CONSTRAINT "wallets_reserved_within_balance" CHECK ("reserved" <= "balance");

ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_balance_after_non_negative" CHECK ("balance_after" >= 0),
  ADD CONSTRAINT "transactions_reserved_after_valid" CHECK ("reserved_after" >= 0 AND "reserved_after" <= "balance_after"),
  ADD CONSTRAINT "transactions_bet_reference" CHECK (("type" = 'DEPOSIT_DEMO') = ("bet_id" IS NULL));

ALTER TABLE "selections" ADD CONSTRAINT "selections_odds_valid" CHECK ("odds" > 1);
ALTER TABLE "bet_selections" ADD CONSTRAINT "bet_selections_odds_valid" CHECK ("odds" > 1);
ALTER TABLE "odds_snapshots" ADD CONSTRAINT "odds_snapshots_odds_valid" CHECK ("odds" > 1);

ALTER TABLE "bets"
  ADD CONSTRAINT "bets_stake_positive" CHECK ("stake" > 0),
  ADD CONSTRAINT "bets_total_odds_valid" CHECK ("total_odds" > 1),
  ADD CONSTRAINT "bets_potential_return_valid" CHECK ("potential_return" >= "stake"),
  ADD CONSTRAINT "bets_payout_non_negative" CHECK ("payout" IS NULL OR "payout" >= 0),
  ADD CONSTRAINT "bets_settlement_consistent" CHECK (("status" = 'PENDING') = ("settled_at" IS NULL));

ALTER TABLE "bet_slips" ADD CONSTRAINT "bet_slips_total_stake_positive" CHECK ("total_stake" > 0);
ALTER TABLE "user_limits" ADD CONSTRAINT "user_limits_amount_non_negative" CHECK ("amount" >= 0 AND ("pending_amount" IS NULL OR "pending_amount" >= 0));

-- ─── Append-only tables ─────────────────────────────────────────────────────

CREATE FUNCTION "storm_reject_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only: % rejected', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "transactions_append_only" BEFORE UPDATE OR DELETE ON "transactions"
  FOR EACH ROW EXECUTE FUNCTION "storm_reject_mutation"();
CREATE TRIGGER "transactions_no_truncate" BEFORE TRUNCATE ON "transactions"
  FOR EACH STATEMENT EXECUTE FUNCTION "storm_reject_mutation"();

CREATE TRIGGER "audit_logs_append_only" BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "storm_reject_mutation"();
CREATE TRIGGER "audit_logs_no_truncate" BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION "storm_reject_mutation"();

CREATE TRIGGER "odds_snapshots_append_only" BEFORE UPDATE OR DELETE ON "odds_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "storm_reject_mutation"();

-- ─── One settlement per bet ─────────────────────────────────────────────────
-- (bet_id, type) is already unique; this closes WON-and-LOST for the same bet.
-- The rule lives in a trigger rather than a partial index because Prisma
-- Migrate cannot represent partial indexes and would try to drop one.

CREATE FUNCTION "storm_guard_settlement_transaction"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bet_status text;
BEGIN
  IF NEW."type" IN ('BET_WON', 'BET_LOST', 'BET_VOID', 'BET_REFUND') THEN
    -- The settling transaction has already moved the bet out of PENDING and
    -- holds its row lock, so this read is stable.
    SELECT "status"::text INTO bet_status FROM "bets" WHERE "id" = NEW."bet_id";
    IF bet_status IS NULL OR bet_status = 'PENDING' THEN
      RAISE EXCEPTION 'settlement transaction for unsettled bet %', NEW."bet_id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."type" = 'BET_WON' AND bet_status <> 'WON')
      OR (NEW."type" = 'BET_LOST' AND bet_status <> 'LOST')
      OR (NEW."type" = 'BET_VOID' AND bet_status <> 'VOID')
      OR (NEW."type" = 'BET_REFUND' AND bet_status <> 'REFUNDED') THEN
      RAISE EXCEPTION 'transaction type % does not match bet status %', NEW."type", bet_status
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "transactions"
      WHERE "bet_id" = NEW."bet_id" AND "type" IN ('BET_WON', 'BET_LOST', 'BET_VOID', 'BET_REFUND')
    ) THEN
      RAISE EXCEPTION 'bet % is already settled in the ledger', NEW."bet_id"
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "transactions_one_settlement_per_bet" BEFORE INSERT ON "transactions"
  FOR EACH ROW EXECUTE FUNCTION "storm_guard_settlement_transaction"();

-- ─── Settled bets are final ─────────────────────────────────────────────────

CREATE FUNCTION "storm_guard_bet"() RETURNS trigger LANGUAGE plpgsql AS $$
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
  RETURN NEW;
END;
$$;

CREATE TRIGGER "bets_guard" BEFORE UPDATE OR DELETE ON "bets"
  FOR EACH ROW EXECUTE FUNCTION "storm_guard_bet"();

CREATE FUNCTION "storm_guard_bet_selection"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bet selections cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."bet_id" <> OLD."bet_id" OR NEW."selection_id" <> OLD."selection_id"
    OR NEW."odds" <> OLD."odds" THEN
    RAISE EXCEPTION 'bet selection % is fixed at placement', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."result" <> 'PENDING' AND NEW."result" <> OLD."result" THEN
    RAISE EXCEPTION 'bet selection % is already resulted', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "bet_selections_guard" BEFORE UPDATE OR DELETE ON "bet_selections"
  FOR EACH ROW EXECUTE FUNCTION "storm_guard_bet_selection"();
