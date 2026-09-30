-- A cashout is a settlement like any other: one per bet, matching the bet's status.
CREATE OR REPLACE FUNCTION "storm_guard_settlement_transaction"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bet_status text;
BEGIN
  IF NEW."type" IN ('BET_WON', 'BET_LOST', 'BET_VOID', 'BET_REFUND', 'CASH_OUT') THEN
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
      OR (NEW."type" = 'BET_REFUND' AND bet_status <> 'REFUNDED')
      OR (NEW."type" = 'CASH_OUT' AND bet_status <> 'CASHED_OUT') THEN
      RAISE EXCEPTION 'transaction type % does not match bet status %', NEW."type", bet_status
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "transactions"
      WHERE "bet_id" = NEW."bet_id"
        AND "type" IN ('BET_WON', 'BET_LOST', 'BET_VOID', 'BET_REFUND', 'CASH_OUT')
    ) THEN
      RAISE EXCEPTION 'bet % is already settled in the ledger', NEW."bet_id"
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- A cashout pays something and never more than the bet could have returned.
ALTER TABLE "bets" ADD CONSTRAINT "bets_cash_out_payout" CHECK (
  "status" <> 'CASHED_OUT' OR ("payout" > 0 AND "payout" <= "potential_return")
);
