import type { Metadata } from 'next';
import Link from 'next/link';
import { Prose } from '@/components/prose';
import { getT } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('Aktionen') };
}

/** Honest promotions page: a demo has no bonuses, so nothing is promised. */
export default async function PromotionsPage() {
  const t = await getT();
  return (
    <Prose>
      <h1>{t('Aktionen')}</h1>
      <p>
        {t('STORM BET läuft im')} <strong>{t('Demo-Modus')}</strong>
        {t(
          '. Es gibt keine Boni, Freispiele oder Gewinnversprechen – weder mit Echtgeld noch mit Spielgeld.',
        )}
      </p>
      <h2>{t('Was du nutzen kannst')}</h2>
      <ul>
        <li>
          <Link href="/dashboard/wallet">{t('Demo-Guthaben auffüllen')}</Link>
          {t(', wenn es aufgebraucht ist (mit Wartezeit, ohne Geldwert).')}
        </li>
        <li>
          <Link href="/casino">{t('Neue Casino-Spiele')}</Link>{' '}
          {t('ausprobieren – Slots, Roulette, Blackjack und Baccarat.')}
        </li>
        <li>
          <Link href="/dashboard/limits">{t('Limits und Selbstsperre')}</Link>{' '}
          {t('einrichten; sie gelten für Sportwetten und Casino gemeinsam.')}
        </li>
      </ul>
      <p>
        {t(
          'Echte Aktionen wären nur mit Glücksspiellizenz und nach den Werberegeln des Glücksspielstaatsvertrags zulässig.',
        )}
      </p>
    </Prose>
  );
}
