-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'SUPPORT', 'TRADER', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'LOCKED', 'CLOSED');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('NOT_REQUIRED', 'NOT_STARTED', 'PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AuthTokenType" AS ENUM ('EMAIL_VERIFICATION', 'PASSWORD_RESET');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('SCHEDULED', 'LIVE', 'SUSPENDED', 'FINISHED', 'CANCELLED', 'POSTPONED');

-- CreateEnum
CREATE TYPE "MarketStatus" AS ENUM ('OPEN', 'SUSPENDED', 'CLOSED', 'SETTLED');

-- CreateEnum
CREATE TYPE "MarketType" AS ENUM ('MATCH_RESULT', 'DOUBLE_CHANCE', 'DRAW_NO_BET', 'TOTAL_GOALS', 'ASIAN_HANDICAP', 'BOTH_TEAMS_TO_SCORE', 'TOTAL_CORNERS', 'TOTAL_CARDS', 'PLAYER_TO_SCORE', 'MATCH_WINNER', 'FIRST_SET_WINNER', 'SET_BETTING', 'TOTAL_GAMES', 'GAME_HANDICAP', 'TOTAL_POINTS', 'POINT_SPREAD');

-- CreateEnum
CREATE TYPE "Outcome" AS ENUM ('HOME', 'DRAW', 'AWAY', 'HOME_OR_DRAW', 'HOME_OR_AWAY', 'DRAW_OR_AWAY', 'OVER', 'UNDER', 'YES', 'NO', 'SETS_2_0', 'SETS_2_1', 'SETS_1_2', 'SETS_0_2', 'PLAYER');

-- CreateEnum
CREATE TYPE "SelectionStatus" AS ENUM ('OPEN', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "SelectionResult" AS ENUM ('PENDING', 'WON', 'LOST', 'VOID');

-- CreateEnum
CREATE TYPE "BetStatus" AS ENUM ('PENDING', 'WON', 'LOST', 'VOID', 'REFUNDED');

-- CreateEnum
CREATE TYPE "BetType" AS ENUM ('SINGLE', 'DOUBLE', 'TRIPLE', 'ACCUMULATOR');

-- CreateEnum
CREATE TYPE "SlipMode" AS ENUM ('SINGLES', 'COMBO');

-- CreateEnum
CREATE TYPE "OddsChangePolicy" AS ENUM ('REJECT', 'ACCEPT_HIGHER');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('DEPOSIT_DEMO', 'BET_PLACED', 'BET_WON', 'BET_LOST', 'BET_VOID', 'BET_REFUND');

-- CreateEnum
CREATE TYPE "LimitType" AS ENUM ('STAKE_PER_BET', 'STAKE_DAILY', 'STAKE_WEEKLY', 'STAKE_MONTHLY');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "email_verified_at" TIMESTAMP(3),
    "locked_at" TIMESTAMP(3),
    "locked_reason" TEXT,
    "country" CHAR(2),
    "date_of_birth" DATE,
    "kyc_status" "KycStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "password_changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "AuthTokenType" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_limits" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "LimitType" NOT NULL,
    "amount" BIGINT NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pending_amount" BIGINT,
    "pending_effective_at" TIMESTAMP(3),
    "set_by_staff" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_limits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "self_exclusions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ends_at" TIMESTAMP(3),
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "self_exclusions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sports" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leagues" (
    "id" UUID NOT NULL,
    "sport_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leagues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL,
    "sport_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "short_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "players" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "players_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" UUID NOT NULL,
    "sport_id" UUID NOT NULL,
    "league_id" UUID NOT NULL,
    "home_team_id" UUID NOT NULL,
    "away_team_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "start_time" TIMESTAMP(3) NOT NULL,
    "status" "EventStatus" NOT NULL DEFAULT 'SCHEDULED',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "trading_suspended" BOOLEAN NOT NULL DEFAULT false,
    "home_score" INTEGER,
    "away_score" INTEGER,
    "live_state" JSONB,
    "statistics" JSONB,
    "result_confirmed_at" TIMESTAMP(3),
    "settled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "markets" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "type" "MarketType" NOT NULL,
    "name" TEXT NOT NULL,
    "line" DECIMAL(6,2),
    "status" "MarketStatus" NOT NULL DEFAULT 'OPEN',
    "trading_suspended" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "settled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "markets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "selections" (
    "id" UUID NOT NULL,
    "market_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "outcome" "Outcome" NOT NULL,
    "player_id" UUID,
    "odds" DECIMAL(8,3) NOT NULL,
    "odds_version" INTEGER NOT NULL DEFAULT 1,
    "odds_updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "SelectionStatus" NOT NULL DEFAULT 'OPEN',
    "suspension_reason" TEXT,
    "result" "SelectionResult" NOT NULL DEFAULT 'PENDING',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "selections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'DEMO',
    "balance" BIGINT NOT NULL DEFAULT 0,
    "reserved" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "last_top_up_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "TransactionType" NOT NULL,
    "amount" BIGINT NOT NULL,
    "reserved_delta" BIGINT NOT NULL,
    "balance_after" BIGINT NOT NULL,
    "reserved_after" BIGINT NOT NULL,
    "bet_id" UUID,
    "description" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bet_slips" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "mode" "SlipMode" NOT NULL,
    "total_stake" BIGINT NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bet_slips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bets" (
    "id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "slip_id" UUID NOT NULL,
    "type" "BetType" NOT NULL,
    "status" "BetStatus" NOT NULL DEFAULT 'PENDING',
    "stake" BIGINT NOT NULL,
    "total_odds" DECIMAL(14,3) NOT NULL,
    "potential_return" BIGINT NOT NULL,
    "payout" BIGINT,
    "odds_change_policy" "OddsChangePolicy" NOT NULL,
    "placed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMP(3),
    "settlement_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bet_selections" (
    "id" UUID NOT NULL,
    "bet_id" UUID NOT NULL,
    "selection_id" UUID NOT NULL,
    "market_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "odds" DECIMAL(8,3) NOT NULL,
    "result" "SelectionResult" NOT NULL DEFAULT 'PENDING',
    "event_name" TEXT NOT NULL,
    "market_name" TEXT NOT NULL,
    "selection_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bet_selections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "odds_snapshots" (
    "id" UUID NOT NULL,
    "bet_selection_id" UUID NOT NULL,
    "selection_id" UUID NOT NULL,
    "odds" DECIMAL(8,3) NOT NULL,
    "odds_version" INTEGER NOT NULL,
    "event_status" "EventStatus" NOT NULL,
    "market_status" "MarketStatus" NOT NULL,
    "home_score" INTEGER,
    "away_score" INTEGER,
    "source" TEXT NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "odds_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "actor_role" "UserRole",
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "users_created_at_idx" ON "users"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "auth_tokens_token_hash_key" ON "auth_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "auth_tokens_user_id_type_idx" ON "auth_tokens"("user_id", "type");

-- CreateIndex
CREATE INDEX "auth_tokens_expires_at_idx" ON "auth_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_limits_user_id_type_key" ON "user_limits"("user_id", "type");

-- CreateIndex
CREATE INDEX "self_exclusions_user_id_ends_at_idx" ON "self_exclusions"("user_id", "ends_at");

-- CreateIndex
CREATE UNIQUE INDEX "sports_key_key" ON "sports"("key");

-- CreateIndex
CREATE INDEX "leagues_sport_id_idx" ON "leagues"("sport_id");

-- CreateIndex
CREATE UNIQUE INDEX "leagues_provider_external_id_key" ON "leagues"("provider", "external_id");

-- CreateIndex
CREATE INDEX "teams_sport_id_idx" ON "teams"("sport_id");

-- CreateIndex
CREATE UNIQUE INDEX "teams_provider_external_id_key" ON "teams"("provider", "external_id");

-- CreateIndex
CREATE INDEX "players_team_id_idx" ON "players"("team_id");

-- CreateIndex
CREATE UNIQUE INDEX "players_provider_external_id_key" ON "players"("provider", "external_id");

-- CreateIndex
CREATE INDEX "events_status_start_time_idx" ON "events"("status", "start_time");

-- CreateIndex
CREATE INDEX "events_sport_id_status_start_time_idx" ON "events"("sport_id", "status", "start_time");

-- CreateIndex
CREATE INDEX "events_league_id_start_time_idx" ON "events"("league_id", "start_time");

-- CreateIndex
CREATE INDEX "events_start_time_idx" ON "events"("start_time");

-- CreateIndex
CREATE INDEX "events_result_confirmed_at_settled_at_idx" ON "events"("result_confirmed_at", "settled_at");

-- CreateIndex
CREATE UNIQUE INDEX "events_provider_external_id_key" ON "events"("provider", "external_id");

-- CreateIndex
CREATE INDEX "markets_event_id_status_idx" ON "markets"("event_id", "status");

-- CreateIndex
CREATE INDEX "markets_status_idx" ON "markets"("status");

-- CreateIndex
CREATE UNIQUE INDEX "markets_event_id_key_key" ON "markets"("event_id", "key");

-- CreateIndex
CREATE INDEX "selections_market_id_idx" ON "selections"("market_id");

-- CreateIndex
CREATE INDEX "selections_status_idx" ON "selections"("status");

-- CreateIndex
CREATE UNIQUE INDEX "selections_market_id_key_key" ON "selections"("market_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_user_id_key" ON "wallets"("user_id");

-- CreateIndex
CREATE INDEX "transactions_user_id_created_at_idx" ON "transactions"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "transactions_wallet_id_created_at_idx" ON "transactions"("wallet_id", "created_at");

-- CreateIndex
CREATE INDEX "transactions_type_idx" ON "transactions"("type");

-- CreateIndex
CREATE INDEX "transactions_created_at_idx" ON "transactions"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_bet_id_type_key" ON "transactions"("bet_id", "type");

-- CreateIndex
CREATE INDEX "bet_slips_user_id_created_at_idx" ON "bet_slips"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "bet_slips_user_id_idempotency_key_key" ON "bet_slips"("user_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "bets_reference_key" ON "bets"("reference");

-- CreateIndex
CREATE INDEX "bets_user_id_status_placed_at_idx" ON "bets"("user_id", "status", "placed_at");

-- CreateIndex
CREATE INDEX "bets_user_id_placed_at_idx" ON "bets"("user_id", "placed_at");

-- CreateIndex
CREATE INDEX "bets_status_idx" ON "bets"("status");

-- CreateIndex
CREATE INDEX "bets_placed_at_idx" ON "bets"("placed_at");

-- CreateIndex
CREATE INDEX "bet_selections_selection_id_idx" ON "bet_selections"("selection_id");

-- CreateIndex
CREATE INDEX "bet_selections_market_id_idx" ON "bet_selections"("market_id");

-- CreateIndex
CREATE INDEX "bet_selections_event_id_result_idx" ON "bet_selections"("event_id", "result");

-- CreateIndex
CREATE UNIQUE INDEX "bet_selections_bet_id_selection_id_key" ON "bet_selections"("bet_id", "selection_id");

-- CreateIndex
CREATE UNIQUE INDEX "odds_snapshots_bet_selection_id_key" ON "odds_snapshots"("bet_selection_id");

-- CreateIndex
CREATE INDEX "odds_snapshots_selection_id_idx" ON "odds_snapshots"("selection_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_target_type_target_id_idx" ON "audit_logs"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_limits" ADD CONSTRAINT "user_limits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "self_exclusions" ADD CONSTRAINT "self_exclusions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leagues" ADD CONSTRAINT "leagues_sport_id_fkey" FOREIGN KEY ("sport_id") REFERENCES "sports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_sport_id_fkey" FOREIGN KEY ("sport_id") REFERENCES "sports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "players" ADD CONSTRAINT "players_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_sport_id_fkey" FOREIGN KEY ("sport_id") REFERENCES "sports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_league_id_fkey" FOREIGN KEY ("league_id") REFERENCES "leagues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_home_team_id_fkey" FOREIGN KEY ("home_team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_away_team_id_fkey" FOREIGN KEY ("away_team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "markets" ADD CONSTRAINT "markets_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "selections" ADD CONSTRAINT "selections_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "selections" ADD CONSTRAINT "selections_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_bet_id_fkey" FOREIGN KEY ("bet_id") REFERENCES "bets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bet_slips" ADD CONSTRAINT "bet_slips_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bets" ADD CONSTRAINT "bets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bets" ADD CONSTRAINT "bets_slip_id_fkey" FOREIGN KEY ("slip_id") REFERENCES "bet_slips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bet_selections" ADD CONSTRAINT "bet_selections_bet_id_fkey" FOREIGN KEY ("bet_id") REFERENCES "bets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bet_selections" ADD CONSTRAINT "bet_selections_selection_id_fkey" FOREIGN KEY ("selection_id") REFERENCES "selections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bet_selections" ADD CONSTRAINT "bet_selections_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bet_selections" ADD CONSTRAINT "bet_selections_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "odds_snapshots" ADD CONSTRAINT "odds_snapshots_bet_selection_id_fkey" FOREIGN KEY ("bet_selection_id") REFERENCES "bet_selections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "odds_snapshots" ADD CONSTRAINT "odds_snapshots_selection_id_fkey" FOREIGN KEY ("selection_id") REFERENCES "selections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
