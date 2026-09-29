import { Prisma, type PrismaClient } from '@storm-bet/database';
import type { CasinoProvider } from './provider';

/**
 * Imports a provider's catalogue. New games and categories are created; what
 * staff manage (status, featured, order, stake bounds) is never overwritten.
 */
export async function syncCasinoCatalog(
  db: PrismaClient,
  provider: CasinoProvider,
): Promise<{ games: number; created: number }> {
  const row = await db.casinoProvider.upsert({
    where: { key: provider.key },
    create: { key: provider.key, name: provider.name, isSimulated: provider.isSimulated },
    update: { name: provider.name, isSimulated: provider.isSimulated },
  });
  const categories = await provider.getCategories();
  await db.casinoCategory.createMany({
    data: categories.map((c) => ({ key: c.key, name: c.name, sortOrder: c.sortOrder })),
    skipDuplicates: true,
  });
  const games = await provider.getGames();
  const created = await db.casinoGame.createMany({
    data: games.map((g) => ({
      providerId: row.id,
      externalId: g.externalId,
      slug: g.slug,
      name: g.name,
      type: g.type,
      categories: g.categories,
      description: g.description,
      isFeatured: g.isFeatured,
      isNew: g.isNew,
      sortOrder: g.sortOrder,
      minStake: BigInt(g.minStake),
      maxStake: BigInt(g.maxStake),
      rtp: new Prisma.Decimal(g.rtp),
      theme: g.theme as unknown as Prisma.InputJsonValue,
    })),
    skipDuplicates: true,
  });
  // Descriptive fields follow the provider.
  for (const g of games) {
    await db.casinoGame.updateMany({
      where: { providerId: row.id, externalId: g.externalId },
      data: {
        name: g.name,
        description: g.description,
        rtp: new Prisma.Decimal(g.rtp),
        theme: g.theme as unknown as Prisma.InputJsonValue,
      },
    });
  }
  return { games: games.length, created: created.count };
}
