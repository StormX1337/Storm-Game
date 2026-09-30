import type { Metadata } from 'next';
import { Prose, Updated } from '@/components/prose';
import { getPlatformMeta } from '@/lib/server-api';
import { getT } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('Nutzungsbedingungen') };
}

export default async function TermsPage() {
  const t = await getT();
  const { odds } = await getPlatformMeta();
  return (
    <Prose>
      <h1>{t('Nutzungsbedingungen')}</h1>
      <Updated date={t('September 2026')} />
      <p>
        {t('Diese Bedingungen regeln die Nutzung der Demonstrationsplattform')}{' '}
        <strong>{t('STORM BET')}</strong>
        {t('. Mit der Registrierung erklärst du dich mit ihnen einverstanden.')}
      </p>
      <h2>{t('1. Demo-Charakter')}</h2>
      <ul>
        <li>
          {t('STORM BET ist eine Software-Demonstration. Es werden')}{' '}
          <strong>{t('keine echten Wetten')}</strong> angeboten.
        </li>
        {odds.isSimulated ? (
          <li>
            {t('Alle Wettbewerbe, Teams, Spieler, Spielverläufe und Quoten sind')}{' '}
            <strong>simuliert</strong> {t('und frei erfunden.')}
          </li>
        ) : (
          <li>
            {t('Spielpläne, Quoten und Ergebnisse stammen vom Datendienst')}{' '}
            <strong>{odds.name}</strong>
            {t('. Sie werden ohne Gewähr übernommen und können verzögert oder fehlerhaft sein.')}
          </li>
        )}
        <li>
          {t('Gewettet wird ausschließlich mit')}{' '}
          <strong>{t('Demo-Guthaben (Spielgeld in €)')}</strong>
          {t(
            '. Es hat keinen Geldwert, ist nicht übertragbar und kann weder eingezahlt noch ausgezahlt werden.',
          )}
        </li>
        <li>
          {t('Es werden keine Gewinne versprochen. Auch Demo-Gewinne haben keinen Gegenwert.')}
        </li>
      </ul>
      <h2>{t('2. Teilnahme')}</h2>
      <ul>
        <li>{t('Die Nutzung ist Personen ab 18 Jahren vorbehalten.')}</li>
        <li>
          {t('Pro Person ist ein Konto zulässig. Zugangsdaten sind vertraulich zu behandeln.')}
        </li>
        <li>
          {t(
            'Missbrauch (automatisierte Anfragen, Umgehung von Limits, Angriffe auf die Plattform) führt zur Sperrung.',
          )}
        </li>
      </ul>
      <h2>{t('3. Wetten und Abrechnung')}</h2>
      <ul>
        <li>
          {t(
            'Eine Wette gilt erst als angenommen, wenn sie serverseitig bestätigt und mit einer Wettnummer versehen wurde.',
          )}
        </li>
        <li>
          {t(
            'Maßgeblich ist die Quote zum Zeitpunkt der Annahme. Hat sie sich geändert, wird die Wette nicht ohne deine ausdrückliche Zustimmung zu einer schlechteren Quote angenommen.',
          )}
        </li>
        <li>
          {t('Die Abrechnung erfolgt nach dem')}{' '}
          {odds.isSimulated ? 'simulierten' : t('vom Datendienst gemeldeten')}{' '}
          {t(
            'Endergebnis. Bei abgesagten Events werden betroffene Auswahlen mit Quote 1,00 gewertet.',
          )}
        </li>
        <li>
          {t(
            'Es gelten Mindest- und Höchsteinsätze sowie ein maximaler Gewinn pro Wette; sie werden im Wettschein angezeigt.',
          )}
        </li>
        <li>
          {t(
            'Bet Builder: mehrere Tipps auf ein Fußballspiel zu einer Quote – vor Anpfiff (auch Torschützen, Ecken und Karten, wenn angeboten) und live (nur Märkte fürs ganze Spiel). Die Quote wird aus einem Tor-Modell berechnet, das an die Quoten des Datendienstes angepasst ist (Marge 8 %, live 10 %), und ist nie höher als das Produkt der Einzelquoten. Alle Tipps müssen gewinnen – verliert einer, ist die Wette verloren. Nur wenn ein Tipp annulliert wird (z. B. Spielabsage, Spieler nicht eingesetzt), wird die ganze Wette storniert und der Einsatz erstattet.',
          )}
        </li>
        <li>
          {t(
            'Quoten-Boosts: ausgewählte Tipps zur um den angegebenen Prozentsatz erhöhten Quote, nur als Einzelwette, mit Höchsteinsatz und einmal pro Konto, bis zum Anpfiff. Kein Cashout.',
          )}
        </li>
        <li>
          {t(
            'Systemwetten (z. B. 2 aus 3): 3 bis 8 Tipps aus verschiedenen Spielen; jede Kombination ist eine eigene Wette mit dem Einsatz pro Wette. Jede Kombination wird wie eine Kombi abgerechnet (stornierte Tipps zählen 1,00); ausgezahlt wird die Summe der gewonnenen Kombinationen, auch wenn sie unter dem Gesamteinsatz liegt. Kein Cashout.',
          )}
        </li>
        <li>
          {t(
            'Frühe Auszahlung: Ein vor Anpfiff platzierter Tipp auf Sieg eines Teams (Fußball, 1X2) gilt als gewonnen, sobald dieses Team mit 2 Toren führt – unabhängig vom Endstand. Gilt auch als Teil einer Kombi, nicht im Bet Builder und nicht für Live-Tipps.',
          )}
        </li>
        <li>
          {t(
            'Zusätzliche Fußball-Märkte (z. B. Doppelte Chance, Beide treffen, weitere Tor-Linien) werden vor Anpfiff mit demselben Modell aus den Quoten des Datendienstes berechnet.',
          )}
        </li>
      </ul>
      <h2>{t('4. Haftung')}</h2>
      <p>
        {t(
          'Die Plattform wird ohne Gewähr für Verfügbarkeit bereitgestellt. Da ausschließlich Spielgeld verwendet wird, entstehen keine finanziellen Ansprüche.',
        )}
      </p>
      <h2>{t('5. Echtgeld')}</h2>
      <p>
        {t(
          'Ein Echtgeldbetrieb ist nicht Bestandteil dieses Angebots. Er würde eine behördliche Glücksspiellizenz, Identitäts- und Altersprüfung, Geolokalisierung, Einzahlungslimits und weitere regulatorische Maßnahmen voraussetzen.',
        )}
      </p>
    </Prose>
  );
}
