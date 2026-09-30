-- Early payout: a pre-match 1X2 pick won by a two-goal lead.
ALTER TABLE "bet_selections" ADD COLUMN "early_payout" BOOLEAN NOT NULL DEFAULT false;
