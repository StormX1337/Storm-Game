import type { Metadata } from 'next';
import Link from 'next/link';
import { Prose } from '@/components/prose';
import { getT } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('Verantwortungsvolles Spielen') };
}

export default async function ResponsibleGamingPage() {
  const t = await getT();
  return (
    <Prose>
      <h1>{t('Verantwortungsvolles Spielen')}</h1>
      <p>
        {t(
          'Sportwetten sollen Unterhaltung sein. Auch wenn STORM BET ausschließlich mit Demo-Guthaben arbeitet, enthält die Plattform die Schutzfunktionen, die ein verantwortungsvoller Anbieter bieten muss.',
        )}
      </p>
      <h2>{t('Werkzeuge in deinem Konto')}</h2>
      <ul>
        <li>
          <strong>{t('Einsatzlimits')}</strong>{' '}
          {t(
            'pro Wette, 24 Stunden, 7 Tage oder 30 Tage. Senkungen gelten sofort, Erhöhungen erst nach 24 Stunden – so bleibt Zeit zum Nachdenken.',
          )}
        </li>
        <li>
          <strong>{t('Selbstsperre')}</strong>{' '}
          {t(
            'für 24 Stunden, 7 Tage, 30 Tage, 6 Monate oder unbefristet. Eine Selbstsperre kann nicht vorzeitig aufgehoben werden.',
          )}
        </li>
        <li>
          <strong>{t('Transparenz:')}</strong>{' '}
          {t('Alle Einsätze, Gewinne und Verluste sind in deiner Buchungsübersicht einsehbar.')}
        </li>
      </ul>
      <p>
        <Link href="/dashboard/limits">{t('Limits und Selbstsperre verwalten')}</Link>
      </p>
      <h2>{t('Warnsignale')}</h2>
      <ul>
        <li>{t('Du wettest mit mehr Geld oder mehr Zeit als geplant.')}</li>
        <li>{t('Du versuchst, Verluste durch weitere Wetten auszugleichen.')}</li>
        <li>{t('Wetten beeinträchtigen Schlaf, Arbeit oder Beziehungen.')}</li>
        <li>{t('Du verheimlichst dein Spielverhalten vor anderen.')}</li>
      </ul>
      <h2>{t('Hilfe')}</h2>
      <ul>
        <li>
          {t('BZgA-Beratungstelefon zur Glücksspielsucht:')} <strong>0800 1 37 27 00</strong>{' '}
          {t('(kostenlos und anonym)')}
        </li>
        <li>
          {t('Online-Beratung:')}{' '}
          <a href="https://www.check-dein-spiel.de" target="_blank" rel="noopener noreferrer">
            check-dein-spiel.de
          </a>
        </li>
        <li>
          {t('Spielersperrsystem OASIS (für lizenzierte Anbieter in Deutschland):')}{' '}
          <a href="https://oasis.rp.hessen.de" target="_blank" rel="noopener noreferrer">
            oasis.rp.hessen.de
          </a>
        </li>
      </ul>
      <h2>{t('Jugendschutz')}</h2>
      <p>
        {t(
          'Die Nutzung ist erst ab 18 Jahren erlaubt. Bei einem Echtgeldbetrieb wäre eine Identitäts- und Altersprüfung verpflichtend.',
        )}
      </p>
    </Prose>
  );
}
