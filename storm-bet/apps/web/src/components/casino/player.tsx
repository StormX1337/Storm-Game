'use client';

import type { CasinoGameDto, CasinoSessionDto } from '@storm-bet/types';
import { Badge, Button, Card, EmptyState, Skeleton, toast } from '@storm-bet/ui';
import { ArrowLeft, Info, LogOut, Wallet } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api-client';
import { formatMoney } from '@/lib/format';
import { useSession } from '../providers/session';
import { BaccaratGame } from './baccarat-game';
import { BlackjackGame } from './blackjack-game';
import { GameSideContext } from './controls';
import { GameCover } from './game-cover';
import { DEMO_MODE_LABEL, GAME_TYPE_LABELS } from './labels';
import { RouletteGame } from './roulette-game';
import { SlotGame } from './slot-game';

const RULES: Record<CasinoGameDto['type'], string> = {
  SLOT: '5 Walzen, 3 Reihen, 10 feste Gewinnlinien. Gewinne zählen von links nach rechts ab 3 gleichen Symbolen; die Auszahlung ist ein Vielfaches des Linieneinsatzes (Einsatz ÷ 10).',
  ROULETTE:
    'Europäisches Roulette mit einer Null. Zahl 35:1, Dutzend/Kolonne 2:1, einfache Chancen 1:1 (verlieren bei 0).',
  BLACKJACK:
    '6 Decks, neu gemischt je Hand. Dealer zieht bis 16 und steht auf allen 17. Blackjack 3:2, Verdoppeln auf die ersten zwei Karten, kein Teilen.',
  BACCARAT:
    'Punto Banco mit 8 Decks und festen Ziehregeln. Spieler 1:1, Bank 0,95:1, Unentschieden 8:1 (Spieler/Bank erhalten ihren Einsatz zurück).',
};

export function GamePlayer({ game }: { game: CasinoGameDto }) {
  const router = useRouter();
  const { wallet } = useSession();
  const [session, setSession] = useState<CasinoSessionDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<CasinoSessionDto>(`/casino/games/${game.id}/session`, { method: 'POST' })
      .then((s) => !cancelled && setSession(s))
      .catch((e: unknown) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [game.id]);

  const leave = async () => {
    if (session)
      await api(`/casino/sessions/${session.id}/close`, { method: 'POST' }).catch(() => undefined);
    toast.success('Spiel beendet');
    router.push('/casino');
  };

  const balance = (
    <Card className="flex items-center gap-3 p-4" data-testid="casino-balance">
      <Wallet className="size-5 text-fg-muted" aria-hidden="true" />
      <div className="flex-1">
        <p className="text-xs text-fg-muted">Verfügbar</p>
        <p className="tabular text-lg font-semibold">
          {wallet ? formatMoney(wallet.available) : '…'}
        </p>
      </div>
      <Button asChild variant="ghost" size="sm">
        <Link href="/dashboard/wallet">Aufladen</Link>
      </Button>
    </Card>
  );
  const info = (
    <Card className="space-y-3 p-4 text-sm">
      <div className="flex items-center gap-2">
        <Info className="size-4 text-fg-muted" aria-hidden="true" />
        <p className="font-semibold">Spielinfo</p>
        <Badge variant="warning" className="ml-auto">
          {DEMO_MODE_LABEL}
        </Badge>
      </div>
      <p className="text-fg-muted">{game.description}</p>
      <dl className="grid grid-cols-2 gap-2 text-xs">
        <dt className="text-fg-subtle">Anbieter</dt>
        <dd>{game.provider.name}</dd>
        <dt className="text-fg-subtle">Typ</dt>
        <dd>{GAME_TYPE_LABELS[game.type]}</dd>
        <dt className="text-fg-subtle">Auszahlungsquote (RTP)</dt>
        <dd className="tabular">
          {game.rtp.toLocaleString('de-DE', { minimumFractionDigits: 2 })} %
        </dd>
        <dt className="text-fg-subtle">Einsatz</dt>
        <dd className="tabular">
          {formatMoney(game.minStake)} – {formatMoney(game.maxStake)}
        </dd>
      </dl>
      <p className="text-xs leading-relaxed text-fg-muted">{RULES[game.type]}</p>
      <p className="text-xs text-fg-subtle">
        Ergebnisse entstehen ausschließlich auf dem Server (kryptografischer Zufall). Nur Spielgeld
        ohne Wert.{' '}
        <Link href="/responsible-gaming" className="underline underline-offset-2">
          Verantwortungsvoll spielen
        </Link>
      </p>
    </Card>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link href="/casino">
            <ArrowLeft /> Lobby
          </Link>
        </Button>
        <h1 className="truncate text-lg font-semibold">{game.name}</h1>
        <Button variant="secondary" size="sm" className="ml-auto" onClick={leave}>
          <LogOut /> Beenden
        </Button>
      </div>
      {error ? (
        <Card>
          <EmptyState icon={<Info />} title="Spiel nicht verfügbar" description={error} />
        </Card>
      ) : !session ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="relative">
            <GameCover
              theme={game.theme}
              name={game.name}
              large
              className="aspect-video rounded-lg"
            />
            <Skeleton className="absolute inset-x-4 bottom-4 h-2" />
          </div>
          <Skeleton className="h-64" />
        </div>
      ) : (
        <GameSideContext.Provider value={{ balance, info }}>
          {game.type === 'SLOT' ? (
            <SlotGame game={game} sessionId={session.id} />
          ) : game.type === 'ROULETTE' ? (
            <RouletteGame game={game} sessionId={session.id} />
          ) : game.type === 'BLACKJACK' ? (
            <BlackjackGame game={game} sessionId={session.id} openRound={session.openRound} />
          ) : (
            <BaccaratGame game={game} sessionId={session.id} />
          )}
        </GameSideContext.Provider>
      )}
    </div>
  );
}
