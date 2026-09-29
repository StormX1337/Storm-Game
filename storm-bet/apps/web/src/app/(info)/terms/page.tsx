import type { Metadata } from 'next';
import { Prose, Updated } from '@/components/prose';
import { getPlatformMeta } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Nutzungsbedingungen' };

export default async function TermsPage() {
  const { odds } = await getPlatformMeta();
  return (
    <Prose>
      <h1>Nutzungsbedingungen</h1>
      <Updated date="September 2026" />
      <p>
        Diese Bedingungen regeln die Nutzung der Demonstrationsplattform <strong>STORM BET</strong>.
        Mit der Registrierung erklärst du dich mit ihnen einverstanden.
      </p>
      <h2>1. Demo-Charakter</h2>
      <ul>
        <li>
          STORM BET ist eine Software-Demonstration. Es werden <strong>keine echten Wetten</strong>{' '}
          angeboten.
        </li>
        {odds.isSimulated ? (
          <li>
            Alle Wettbewerbe, Teams, Spieler, Spielverläufe und Quoten sind{' '}
            <strong>simuliert</strong> und frei erfunden.
          </li>
        ) : (
          <li>
            Spielpläne, Quoten und Ergebnisse stammen vom Datendienst <strong>{odds.name}</strong>.
            Sie werden ohne Gewähr übernommen und können verzögert oder fehlerhaft sein.
          </li>
        )}
        <li>
          Gewettet wird ausschließlich mit <strong>Demo-Guthaben (DEMO)</strong>. Es hat keinen
          Geldwert, ist nicht übertragbar und kann weder eingezahlt noch ausgezahlt werden.
        </li>
        <li>Es werden keine Gewinne versprochen. Auch Demo-Gewinne haben keinen Gegenwert.</li>
      </ul>
      <h2>2. Teilnahme</h2>
      <ul>
        <li>Die Nutzung ist Personen ab 18 Jahren vorbehalten.</li>
        <li>Pro Person ist ein Konto zulässig. Zugangsdaten sind vertraulich zu behandeln.</li>
        <li>
          Missbrauch (automatisierte Anfragen, Umgehung von Limits, Angriffe auf die Plattform)
          führt zur Sperrung.
        </li>
      </ul>
      <h2>3. Wetten und Abrechnung</h2>
      <ul>
        <li>
          Eine Wette gilt erst als angenommen, wenn sie serverseitig bestätigt und mit einer
          Wettnummer versehen wurde.
        </li>
        <li>
          Maßgeblich ist die Quote zum Zeitpunkt der Annahme. Hat sie sich geändert, wird die Wette
          nicht ohne deine ausdrückliche Zustimmung zu einer schlechteren Quote angenommen.
        </li>
        <li>
          Die Abrechnung erfolgt nach dem{' '}
          {odds.isSimulated ? 'simulierten' : 'vom Datendienst gemeldeten'} Endergebnis. Bei
          abgesagten Events werden betroffene Auswahlen mit Quote 1,00 gewertet.
        </li>
        <li>
          Es gelten Mindest- und Höchsteinsätze sowie ein maximaler Gewinn pro Wette; sie werden im
          Wettschein angezeigt.
        </li>
        <li>
          Bet Builder: mehrere Tipps auf ein Fußballspiel (vor Anpfiff) zu einer Quote. Sie wird aus
          einem Tor-Modell berechnet, das an die Quoten des Datendienstes angepasst ist (Marge 8 %),
          und ist nie höher als das Produkt der Einzelquoten. Alle Tipps müssen gewinnen; ist einer
          ungültig, wird die ganze Wette storniert (Einsatz zurück).
        </li>
        <li>
          Zusätzliche Fußball-Märkte (z. B. Doppelte Chance, Beide treffen, weitere Tor-Linien)
          werden vor Anpfiff mit demselben Modell aus den Quoten des Datendienstes berechnet.
        </li>
      </ul>
      <h2>4. Haftung</h2>
      <p>
        Die Plattform wird ohne Gewähr für Verfügbarkeit bereitgestellt. Da ausschließlich Spielgeld
        verwendet wird, entstehen keine finanziellen Ansprüche.
      </p>
      <h2>5. Echtgeld</h2>
      <p>
        Ein Echtgeldbetrieb ist nicht Bestandteil dieses Angebots. Er würde eine behördliche
        Glücksspiellizenz, Identitäts- und Altersprüfung, Geolokalisierung, Einzahlungslimits und
        weitere regulatorische Maßnahmen voraussetzen.
      </p>
    </Prose>
  );
}
