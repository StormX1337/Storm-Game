-- Cashout: a player closes an open bet early at the offered value.
ALTER TYPE "BetStatus" ADD VALUE 'CASHED_OUT';
ALTER TYPE "TransactionType" ADD VALUE 'CASH_OUT';
