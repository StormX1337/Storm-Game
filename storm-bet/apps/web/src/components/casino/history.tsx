'use client';

import type { CasinoRoundDto, Paginated } from '@storm-bet/types';
import { Badge, Card, EmptyState, Table, Td, Th } from '@storm-bet/ui';
import { History } from 'lucide-react';
import { LoadMore } from '@/components/dashboard/load-more';
import { formatDateTime, formatMoney } from '@/lib/format';

const STATUS = {
  SETTLED: { label: 'Abgerechnet', variant: 'success' },
  OPEN: { label: 'Offen', variant: 'warning' },
  REFUNDED: { label: 'Erstattet', variant: 'outline' },
} as const;

function summary(r: CasinoRoundDto): string {
  const x = r.result;
  switch (x.game) {
    case 'SLOT':
      return x.wins.length ? `${x.wins.length} Gewinnlinie(n)` : 'Kein Gewinn';
    case 'ROULETTE':
      return `Zahl ${x.number}`;
    case 'BLACKJACK':
      return x.outcome ? `${x.playerTotal} : ${x.dealerTotal ?? '–'}` : 'Hand läuft';
    case 'CRASH':
      return `Ziel ${x.target.toFixed(2)}× · Crash ${x.crashPoint.toFixed(2)}×`;
    case 'PLINKO':
      return `${x.multiplier}× (${x.risk === 'low' ? 'niedrig' : x.risk === 'medium' ? 'mittel' : 'hoch'})`;
    case 'MINES':
      return x.outcome === 'mine'
        ? `Mine nach ${x.revealed.length} Feldern`
        : x.outcome
          ? `${x.revealed.length} Felder · ${x.multiplier.toFixed(2)}×`
          : 'Runde läuft';
    case 'BACCARAT':
      return `${x.playerTotal} : ${x.bankerTotal} (${x.winner === 'player' ? 'Spieler' : x.winner === 'banker' ? 'Bank' : 'Unentschieden'})`;
  }
}

function Row({ r }: { r: CasinoRoundDto }) {
  return (
    <tr data-testid="casino-round">
      <Td className="font-medium">{r.gameName}</Td>
      <Td className="font-mono text-xs text-fg-subtle" title={r.id}>
        {r.id.slice(0, 8)}
      </Td>
      <Td className="tabular text-right">{formatMoney(r.stake)}</Td>
      <Td className="text-xs">{summary(r)}</Td>
      <Td className={`tabular text-right ${r.payout > 0 ? 'text-up' : 'text-fg-muted'}`}>
        {formatMoney(r.payout)}
      </Td>
      <Td className="whitespace-nowrap text-xs">{formatDateTime(r.createdAt)}</Td>
      <Td>
        <Badge variant={STATUS[r.status].variant}>{STATUS[r.status].label}</Badge>
      </Td>
    </tr>
  );
}

export function CasinoHistory({ initial }: { initial: Paginated<CasinoRoundDto> }) {
  if (initial.items.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<History />}
          title="Noch keine Runden"
          description="Gespielte Casino-Runden erscheinen hier."
        />
      </Card>
    );
  }
  return (
    <Card className="overflow-x-auto">
      <Table>
        <thead>
          <tr>
            <Th>Spiel</Th>
            <Th>Runden-ID</Th>
            <Th className="text-right">Einsatz</Th>
            <Th>Ergebnis</Th>
            <Th className="text-right">Auszahlung</Th>
            <Th>Datum</Th>
            <Th>Status</Th>
          </tr>
        </thead>
        <tbody>
          {initial.items.map((r) => (
            <Row key={r.id} r={r} />
          ))}
          <LoadMore
            asRow
            path="/casino/history"
            initialCursor={initial.nextCursor}
            render={(items: CasinoRoundDto[]) => items.map((r) => <Row key={r.id} r={r} />)}
          />
        </tbody>
      </Table>
    </Card>
  );
}
