import type { Metadata } from 'next';
import Link from 'next/link';
import { Prose } from '@/components/prose';

export const metadata: Metadata = { title: 'Aktionen' };

/** Honest promotions page: a demo has no bonuses, so nothing is promised. */
export default function PromotionsPage() {
  return (
    <Prose>
      <h1>Aktionen</h1>
      <p>
        STORM BET läuft im <strong>Demo-Modus</strong>. Es gibt keine Boni, Freispiele oder
        Gewinnversprechen – weder mit Echtgeld noch mit Spielgeld.
      </p>
      <h2>Was du nutzen kannst</h2>
      <ul>
        <li>
          <Link href="/dashboard/wallet">Demo-Guthaben auffüllen</Link>, wenn es aufgebraucht ist
          (mit Wartezeit, ohne Geldwert).
        </li>
        <li>
          <Link href="/casino">Neue Casino-Spiele</Link> ausprobieren – Slots, Roulette, Blackjack
          und Baccarat.
        </li>
        <li>
          <Link href="/dashboard/limits">Limits und Selbstsperre</Link> einrichten; sie gelten für
          Sportwetten und Casino gemeinsam.
        </li>
      </ul>
      <p>
        Echte Aktionen wären nur mit Glücksspiellizenz und nach den Werberegeln des
        Glücksspielstaatsvertrags zulässig.
      </p>
    </Prose>
  );
}
