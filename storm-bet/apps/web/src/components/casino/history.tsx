'use client';

import type { CasinoRoundDto, Paginated } from '@storm-bet/types';
import { Badge, Card, EmptyState, Table, Td, Th } from '@storm-bet/ui';
import { History } from 'lucide-react';
import { LoadMore } from '@/components/dashboard/load-more';
import { formatDateTime, formatMoney } from '@/lib/format';
import { useT } from '@/i18n/client';
import type { T } from '@/i18n/translate';

const STATUS = {
  SETTLED: { label: 'Abgerechnet', variant: 'success' },
  OPEN: { label: 'Offen', variant: 'warning' },
  REFUNDED: { label: 'Erstattet', variant: 'outline' },
} as const;

function summary(r: CasinoRoundDto, t: T): string {
  const x = r.result;
  switch (x.game) {
    case 'SLOT':
      return x.wins.length ? t('{0} Gewinnlinie(n)', [x.wins.length]) : t('Kein Gewinn');
    case 'ROULETTE':
      return t('Zahl {0}', [x.number]);
    case 'BLACKJACK':
      return x.outcome ? `${x.playerTotal} : ${x.dealerTotal ?? '–'}` : t('Hand läuft');
    case 'CRASH':
      return t('Ziel {0}× · Crash {1}×', [x.target.toFixed(2), x.crashPoint.toFixed(2)]);
    case 'PLINKO':
      return `${x.multiplier}× (${t(x.risk === 'low' ? 'niedrig' : x.risk === 'medium' ? 'mittel' : 'hoch')})`;
    case 'MINES':
      return x.outcome === 'mine'
        ? t('Mine nach {0} Feldern', [x.revealed.length])
        : x.outcome
          ? t('{0} Felder · {1}×', [x.revealed.length, x.multiplier.toFixed(2)])
          : t('Runde läuft');
    case 'DICE':
      return `${x.roll.toFixed(2)} (${t(x.direction === 'under' ? 'unter' : 'über')} ${x.threshold.toFixed(2)})`;
    case 'KENO':
      return t('{0}/{1} Treffer · {2}×', [x.hits.length, x.picks.length, x.multiplier]);
    case 'WHEEL':
      return `${x.multiplier}×`;
    case 'HILO':
      return x.outcome === 'lost'
        ? t('Verloren nach {0} Treffern', [x.history.filter((h) => h.won).length])
        : x.outcome
          ? `${x.multiplier.toFixed(2)}×`
          : t('Runde läuft');
    case 'VIDEO_POKER':
      return x.final
        ? x.multiplier
          ? `${x.multiplier}×`
          : t('Keine Gewinnhand')
        : t('Hand läuft');
    case 'BACCARAT':
      return `${x.playerTotal} : ${x.bankerTotal} (${t(x.winner === 'player' ? 'Spieler' : x.winner === 'banker' ? 'Bank' : 'Unentschieden')})`;
  }
}

function Row({ r }: { r: CasinoRoundDto }) {
  const t = useT();
  return (
    <tr data-testid="casino-round">
      <Td className="font-medium">{t(r.gameName)}</Td>
      <Td className="font-mono text-xs text-fg-subtle" title={r.id}>
        {r.id.slice(0, 8)}
      </Td>
      <Td className="tabular text-right">{formatMoney(r.stake)}</Td>
      <Td className="text-xs">{summary(r, t)}</Td>
      <Td className={`tabular text-right ${r.payout > 0 ? 'text-up' : 'text-fg-muted'}`}>
        {formatMoney(r.payout)}
      </Td>
      <Td className="whitespace-nowrap text-xs">{formatDateTime(r.createdAt)}</Td>
      <Td>
        <Badge variant={STATUS[r.status].variant}>{t(STATUS[r.status].label)}</Badge>
      </Td>
    </tr>
  );
}

export function CasinoHistory({ initial }: { initial: Paginated<CasinoRoundDto> }) {
  const t = useT();
  if (initial.items.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<History />}
          title={t('Noch keine Runden')}
          description={t('Gespielte Casino-Runden erscheinen hier.')}
        />
      </Card>
    );
  }
  return (
    <Card className="overflow-x-auto">
      <Table>
        <thead>
          <tr>
            <Th>{t('Spiel')}</Th>
            <Th>{t('Runden-ID')}</Th>
            <Th className="text-right">{t('Einsatz')}</Th>
            <Th>{t('Ergebnis')}</Th>
            <Th className="text-right">{t('Auszahlung')}</Th>
            <Th>{t('Datum')}</Th>
            <Th>{t('Status')}</Th>
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
