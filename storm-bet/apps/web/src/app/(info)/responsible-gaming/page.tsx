import type { Metadata } from 'next';
import Link from 'next/link';
import { Prose } from '@/components/prose';

export const metadata: Metadata = { title: 'Verantwortungsvolles Spielen' };

export default function ResponsibleGamingPage() {
  return (
    <Prose>
      <h1>Verantwortungsvolles Spielen</h1>
      <p>
        Sportwetten sollen Unterhaltung sein. Auch wenn STORM BET ausschließlich mit Demo-Guthaben
        arbeitet, enthält die Plattform die Schutzfunktionen, die ein verantwortungsvoller Anbieter
        bieten muss.
      </p>
      <h2>Werkzeuge in deinem Konto</h2>
      <ul>
        <li>
          <strong>Einsatzlimits</strong> pro Wette, 24 Stunden, 7 Tage oder 30 Tage. Senkungen
          gelten sofort, Erhöhungen erst nach 24 Stunden – so bleibt Zeit zum Nachdenken.
        </li>
        <li>
          <strong>Selbstsperre</strong> für 24 Stunden, 7 Tage, 30 Tage, 6 Monate oder unbefristet.
          Eine Selbstsperre kann nicht vorzeitig aufgehoben werden.
        </li>
        <li>
          <strong>Transparenz:</strong> Alle Einsätze, Gewinne und Verluste sind in deiner
          Buchungsübersicht einsehbar.
        </li>
      </ul>
      <p>
        <Link href="/dashboard/limits">Limits und Selbstsperre verwalten</Link>
      </p>
      <h2>Warnsignale</h2>
      <ul>
        <li>Du wettest mit mehr Geld oder mehr Zeit als geplant.</li>
        <li>Du versuchst, Verluste durch weitere Wetten auszugleichen.</li>
        <li>Wetten beeinträchtigen Schlaf, Arbeit oder Beziehungen.</li>
        <li>Du verheimlichst dein Spielverhalten vor anderen.</li>
      </ul>
      <h2>Hilfe</h2>
      <ul>
        <li>
          BZgA-Beratungstelefon zur Glücksspielsucht: <strong>0800 1 37 27 00</strong> (kostenlos
          und anonym)
        </li>
        <li>
          Online-Beratung:{' '}
          <a href="https://www.check-dein-spiel.de" target="_blank" rel="noopener noreferrer">
            check-dein-spiel.de
          </a>
        </li>
        <li>
          Spielersperrsystem OASIS (für lizenzierte Anbieter in Deutschland):{' '}
          <a href="https://oasis.rp.hessen.de" target="_blank" rel="noopener noreferrer">
            oasis.rp.hessen.de
          </a>
        </li>
      </ul>
      <h2>Jugendschutz</h2>
      <p>
        Die Nutzung ist erst ab 18 Jahren erlaubt. Bei einem Echtgeldbetrieb wäre eine Identitäts-
        und Altersprüfung verpflichtend.
      </p>
    </Prose>
  );
}
