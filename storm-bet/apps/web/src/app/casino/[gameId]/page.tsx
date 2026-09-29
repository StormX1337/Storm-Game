import type { CasinoGameDto } from '@storm-bet/types';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { GamePlayer } from '@/components/casino/player';
import { tryServerApi } from '@/lib/server-api';

type Props = { params: Promise<{ gameId: string }> };

async function load(gameId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(gameId)) return null;
  return tryServerApi<CasinoGameDto>(`/casino/games/${gameId}`);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const game = await load((await params).gameId);
  return { title: game?.name ?? 'Spiel' };
}

export default async function CasinoGamePage({ params }: Props) {
  const game = await load((await params).gameId);
  if (!game) notFound();
  return <GamePlayer game={game} />;
}
