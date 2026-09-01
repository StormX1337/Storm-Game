-- Which optional panels a template's servers get. A plugin browser makes sense
-- for Minecraft and nowhere else, and keying that off the slug would break the
-- moment an operator imports their own Minecraft template or renames one — so
-- the template says what it supports instead of the panel guessing from a name.
ALTER TABLE "game_templates" ADD COLUMN "features" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- The one template that ships with a plugin ecosystem the panel can reach.
UPDATE "game_templates" SET "features" = ARRAY['plugins'] WHERE "slug" = 'minecraft-java';
