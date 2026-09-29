'use client';

import type { BetDto } from '@storm-bet/types';
import { BetCard } from './bet-card';
import { LoadMore } from './load-more';

export function MoreBets({ path, cursor }: { path: string; cursor: string | null }) {
  return (
    <LoadMore<BetDto>
      path={path}
      initialCursor={cursor}
      render={(items) =>
        items.map((bet) => <BetCard key={bet.id} bet={bet} href={`/dashboard/bets/${bet.id}`} />)
      }
    />
  );
}
