import type { Metadata } from 'next';
import { Prose, Updated } from '@/components/prose';

export const metadata: Metadata = { title: 'Datenschutz' };

export default function PrivacyPage() {
  return (
    <Prose>
      <h1>Datenschutzhinweise</h1>
      <Updated date="September 2026" />
      <p>
        Wir verarbeiten nur die Daten, die für den Betrieb der Demo-Plattform erforderlich sind.
        Diese Hinweise beschreiben die technische Umsetzung; für einen produktiven Betrieb ist eine
        vollständige Datenschutzerklärung des jeweiligen Betreibers erforderlich.
      </p>
      <h2>Welche Daten wir speichern</h2>
      <ul>
        <li>
          <strong>Konto:</strong> E-Mail-Adresse, Anzeigename, optional Land. Passwörter werden
          ausschließlich als Argon2id-Hash gespeichert.
        </li>
        <li>
          <strong>Sitzungen:</strong> ein zufälliges Sitzungstoken (gespeichert nur als
          SHA-256-Hash), Zeitpunkte, IP-Adresse und Browserkennung zur Anzeige deiner aktiven
          Sitzungen.
        </li>
        <li>
          <strong>Wetten und Buchungen:</strong> Demo-Einsätze, Quoten zum Annahmezeitpunkt und alle
          Guthabenbewegungen – zur Nachvollziehbarkeit unveränderlich.
        </li>
        <li>
          <strong>Protokoll:</strong> sicherheitsrelevante Aktionen (Anmeldung, Änderungen durch
          Mitarbeiter) mit Zeitpunkt und – sofern zulässig – IP-Adresse.
        </li>
      </ul>
      <h2>Cookies</h2>
      <ul>
        <li>
          <code>sb_session</code> – Anmeldung (HttpOnly, SameSite=Lax, bei HTTPS „Secure“).
        </li>
        <li>
          <code>sb_csrf</code> – Schutz vor Cross-Site-Request-Forgery.
        </li>
      </ul>
      <p>
        Es werden keine Tracking- oder Werbe-Cookies eingesetzt. Der Wettschein wird lokal in deinem
        Browser gespeichert.
      </p>
      <h2>Deine Rechte</h2>
      <p>
        Du kannst Auskunft, Berichtigung und Löschung deiner Daten verlangen, soweit keine
        Aufbewahrungspflichten entgegenstehen. Wende dich dazu über das{' '}
        <a href="/contact">Kontaktformular</a> an uns.
      </p>
    </Prose>
  );
}
