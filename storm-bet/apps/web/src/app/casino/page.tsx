import type { CasinoLobbyDto } from '@storm-bet/types';
import type { Metadata } from 'next';
import Link from 'next/link';
import { CasinoLobby } from '@/components/casino/lobby';
import { PageHeader } from '@/components/sportsbook/page-header';
import { serverApi } from '@/lib/server-api';

export const metadata: Metadata = { title: { absolute: 'Casino · STORM BET' } };

export default async function CasinoPage() {
  const lobby = await serverApi<CasinoLobbyDto>('/casino/games');
  return (
    <>
      <PageHeader
        title="Casino"
        description="Slots, Roulette, Blackjack und Baccarat – ausschließlich mit Spielgeld, Ergebnisse vom Server."
        actions={
          <Link href="/casino/history" className="text-sm text-accent hover:underline">
            Mein Verlauf
          </Link>
        }
      />
      <CasinoLobby lobby={lobby} />
    </>
  );
}
