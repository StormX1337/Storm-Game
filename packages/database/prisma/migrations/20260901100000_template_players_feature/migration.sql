-- Minecraft keeps its operators, whitelist and bans in files beside the world,
-- and accepts changes to them as console commands. Both halves are things the
-- panel can do, so the template says so.
UPDATE "game_templates"
SET "features" = ARRAY['plugins', 'players']
WHERE "slug" = 'minecraft-java';
