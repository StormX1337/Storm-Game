import type { Metadata } from 'next';
import { Prose, Updated } from '@/components/prose';
import { getT } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('Datenschutz') };
}

export default async function PrivacyPage() {
  const t = await getT();
  return (
    <Prose>
      <h1>{t('Datenschutzhinweise')}</h1>
      <Updated date={t('September 2026')} />
      <p>
        {t(
          'Wir verarbeiten nur die Daten, die für den Betrieb der Demo-Plattform erforderlich sind. Diese Hinweise beschreiben die technische Umsetzung; für einen produktiven Betrieb ist eine vollständige Datenschutzerklärung des jeweiligen Betreibers erforderlich.',
        )}
      </p>
      <h2>{t('Welche Daten wir speichern')}</h2>
      <ul>
        <li>
          <strong>{t('Konto:')}</strong>{' '}
          {t(
            'E-Mail-Adresse, Anzeigename, optional Land. Passwörter werden ausschließlich als Argon2id-Hash gespeichert.',
          )}
        </li>
        <li>
          <strong>{t('Sitzungen:')}</strong>{' '}
          {t(
            'ein zufälliges Sitzungstoken (gespeichert nur als SHA-256-Hash), Zeitpunkte, IP-Adresse und Browserkennung zur Anzeige deiner aktiven Sitzungen.',
          )}
        </li>
        <li>
          <strong>{t('Wetten und Buchungen:')}</strong>{' '}
          {t(
            'Demo-Einsätze, Quoten zum Annahmezeitpunkt und alle Guthabenbewegungen – zur Nachvollziehbarkeit unveränderlich.',
          )}
        </li>
        <li>
          <strong>{t('Protokoll:')}</strong>{' '}
          {t(
            'sicherheitsrelevante Aktionen (Anmeldung, Änderungen durch Mitarbeiter) mit Zeitpunkt und – sofern zulässig – IP-Adresse.',
          )}
        </li>
      </ul>
      <h2>{t('Cookies')}</h2>
      <ul>
        <li>
          <code>sb_session</code> {t('– Anmeldung (HttpOnly, SameSite=Lax, bei HTTPS „Secure“).')}
        </li>
        <li>
          <code>sb_csrf</code> {t('– Schutz vor Cross-Site-Request-Forgery.')}
        </li>
      </ul>
      <p>
        {t(
          'Es werden keine Tracking- oder Werbe-Cookies eingesetzt. Der Wettschein wird lokal in deinem Browser gespeichert.',
        )}
      </p>
      <h2>{t('Deine Rechte')}</h2>
      <p>
        {t(
          'Du kannst Auskunft, Berichtigung und Löschung deiner Daten verlangen, soweit keine Aufbewahrungspflichten entgegenstehen. Wende dich dazu über das',
        )}{' '}
        <a href="/contact">{t('Kontaktformular')}</a> {t('an uns.')}
      </p>
    </Prose>
  );
}
