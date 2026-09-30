-- CreateEnum
CREATE TYPE "IncidentKind" AS ENUM ('KICK_OFF', 'PERIOD_START', 'HALF_TIME', 'FULL_TIME', 'GOAL', 'GOAL_CANCELLED', 'YELLOW_CARD', 'RED_CARD', 'CORNER');

-- CreateTable
CREATE TABLE "event_incidents" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "kind" "IncidentKind" NOT NULL,
    "side" TEXT,
    "clock" TEXT,
    "period" TEXT,
    "player_name" TEXT,
    "home_score" INTEGER,
    "away_score" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "event_incidents_event_id_created_at_idx" ON "event_incidents"("event_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "event_incidents_event_id_key_key" ON "event_incidents"("event_id", "key");

-- AddForeignKey
ALTER TABLE "event_incidents" ADD CONSTRAINT "event_incidents_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "event_incidents" ADD CONSTRAINT "event_incidents_side_valid" CHECK ("side" IS NULL OR "side" IN ('HOME', 'AWAY'));
