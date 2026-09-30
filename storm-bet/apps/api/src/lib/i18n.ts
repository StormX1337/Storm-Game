import type { FastifyRequest } from 'fastify';

/**
 * English for the messages the API sends to players (the German text is the
 * key). Chosen by the site's `lang` cookie; staff-only messages stay German.
 */
const EN: Record<string, string> = {
  'Abgerechnete Auswahlen sind unveränderlich.': 'Settled selections cannot be changed.',
  'Abgerechnete Märkte sind unveränderlich.': 'Settled markets cannot be changed.',
  'Anzahl der Minen fehlt.': 'Number of mines missing.',
  'Auswahl nicht gefunden.': 'Selection not found.',
  'Auswahlen aus demselben Spiel können nicht mit anderen Spielen kombiniert werden. Mehrere Tipps auf ein Spiel: Bet Builder (nur dieses Spiel im Wettschein).':
    'Selections from the same match cannot be combined with other matches. Several picks on one match: Bet Builder (only this match in the bet slip).',
  'Beende zuerst die laufende Hand.': 'Finish the current hand first.',
  'Betrag darf nicht negativ sein': 'Amount must not be negative',
  'Betrag muss größer als 0 sein': 'Amount must be greater than 0',
  'Betrag muss in Cent angegeben werden': 'Amount must be given in cents',
  'Bitte akzeptiere die Nutzungsbedingungen': 'Please accept the terms of use',
  'Bitte bestätige die Selbstsperre': 'Please confirm the self-exclusion',
  'Bitte bestätige mit deinem Passwort': 'Please confirm with your password',
  'Bitte bestätige zuerst deine E-Mail-Adresse.': 'Please verify your email address first.',
  'Bitte bestätige, dass du mindestens 18 Jahre alt bist':
    'Please confirm that you are at least 18 years old',
  'Bitte gib dein Passwort ein': 'Please enter your password',
  'Bitte gib dein aktuelles Passwort ein': 'Please enter your current password',
  'Bitte gib den 6-stelligen Code ein': 'Please enter the 6-digit code',
  'Bitte gib den Code ein': 'Please enter the code',
  'Bitte gib eine gültige E-Mail-Adresse ein': 'Please enter a valid email address',
  'Bitte melde dich an, um fortzufahren.': 'Please log in to continue.',
  'Bitte starte die Einrichtung erneut.': 'Please start the setup again.',
  'Bitte überprüfe deine Eingaben.': 'Please check your input.',
  'Cashout ist gerade nicht möglich (Markt gesperrt).':
    'Cashout is not possible right now (market suspended).',
  'Das Event hat bereits begonnen.': 'The event has already started.',
  'Das Event wurde abgesagt.': 'The event was cancelled.',
  'Das Passwort ist falsch.': 'The password is wrong.',
  'Das aktuelle Passwort ist falsch.': 'The current password is wrong.',
  'Dein Demo-Guthaben reicht für diesen Einsatz nicht aus.':
    'Your demo balance is not enough for this stake.',
  'Dein Konto ist für Spiele gesperrt.': 'Your account is locked for games.',
  'Dein Konto ist für Wetten gesperrt.': 'Your account is locked for betting.',
  'Deine E-Mail-Adresse ist bereits bestätigt.': 'Your email address is already verified.',
  'Der Cashout-Wert hat sich geändert.': 'The cashout value has changed.',
  'Der Code stimmt nicht.': 'The code is wrong.',
  'Der Dienst ist vorübergehend nicht verfügbar.': 'The service is temporarily unavailable.',
  'Der Einsatz überschreitet ein gültiges Limit.': 'The stake exceeds a limit.',
  'Der Link ist ungültig oder abgelaufen. Bitte fordere einen neuen an.':
    'The link is invalid or has expired. Please request a new one.',
  'Der Teil ist zu klein.': 'The part is too small.',
  'Der Wettschein ist leer.': 'The bet slip is empty.',
  'Der angeforderte Eintrag wurde nicht gefunden.': 'The requested item was not found.',
  'Die Anfrage ist zu groß.': 'The request is too large.',
  'Die Anfrage konnte nicht gelesen werden.': 'The request could not be read.',
  'Die Anfrage steht im Konflikt mit dem aktuellen Stand.':
    'The request conflicts with the current state.',
  'Die Anmeldung ist abgelaufen. Bitte melde dich erneut an.':
    'The login has expired. Please log in again.',
  'Die Bet-Builder-Quote hat sich geändert.': 'The Bet Builder odds have changed.',
  'Die Hand hat sich geändert. Bitte neu laden.': 'The hand has changed. Please reload.',
  'Die Hand ist beendet.': 'The hand is over.',
  'Die Runde hat sich geändert. Bitte neu laden.': 'The round has changed. Please reload.',
  'Die Runde ist beendet.': 'The round is over.',
  'Die Spielsitzung ist beendet. Bitte starte das Spiel neu.':
    'The game session has ended. Please restart the game.',
  'Die Wette ist bereits abgerechnet.': 'The bet has already been settled.',
  'Die Wette ist bereits verloren.': 'The bet is already lost.',
  'Die Wette wird gerade abgerechnet.': 'The bet is being settled.',
  'Die Zwei-Faktor-Anmeldung ist bereits aktiv.': 'Two-factor login is already active.',
  'Die Zwei-Faktor-Anmeldung ist nicht aktiv.': 'Two-factor login is not active.',
  'Diese Aktion ist gerade nicht möglich.': 'This action is not possible right now.',
  'Diese Auswahl existiert nicht mehr.': 'This selection no longer exists.',
  'Diese Auswahl ist derzeit gesperrt.': 'This selection is currently suspended.',
  'Diese Auswahl ist nicht mehr verfügbar.': 'This selection is no longer available.',
  'Diese Kombination ist praktisch sicher – keine Quote möglich.':
    'This combination is practically certain – no price possible.',
  'Diese Kombination kann nicht gewinnen.': 'This combination cannot win.',
  'Diese Schnittstelle existiert nicht.': 'This endpoint does not exist.',
  'Dieser Boost ist nicht mehr verfügbar.': 'This boost is no longer available.',
  'Dieser Boost ist nicht verfügbar.': 'This boost is not available.',
  'Diesen Boost hast du bereits genutzt.': 'You have already used this boost.',
  'Dieser Markt ist derzeit gesperrt.': 'This market is currently suspended.',
  'Dieser Markt ist geschlossen.': 'This market is closed.',
  'Dieser Markt ist im Bet Builder nicht verfügbar.':
    'This market is not available in the Bet Builder.',
  'Dieser Schlüssel wurde bereits für eine andere Runde verwendet.':
    'This key has already been used for another round.',
  'Dieser Torschütze kann nicht im Bet Builder gewählt werden.':
    'This goalscorer cannot be chosen in the Bet Builder.',
  'Dieser Wettschein wurde bereits mit anderem Inhalt gesendet.':
    'This bet slip was already sent with different content.',
  'Dieses Event ist nicht mehr im Angebot.': 'This event is no longer offered.',
  'Dieses Konto ist gesperrt. Bitte wende dich an den Support.':
    'This account is locked. Please contact support.',
  'Dieses Konto wurde geschlossen.': 'This account has been closed.',
  'Dieses Spiel ist gerade in Wartung.': 'This game is under maintenance.',
  'Dieses Spiel wird beim Anbieter gespielt.': 'This game is played at the provider.',
  'Du kannst dein Demo-Guthaben nur einmal pro Tag aufladen.':
    'You can only top up your demo balance once a day.',
  'E-Mail-Adresse ist zu lang': 'Email address is too long',
  'E-Mail-Adresse oder Passwort ist falsch.': 'Email address or password is wrong.',
  'Ecken sind für dieses Spiel nicht im Bet Builder verfügbar.':
    'Corners are not available in the Bet Builder for this match.',
  'Ein Teil-Cashout muss kleiner sein als der offene Einsatz.':
    'A partial cashout must be smaller than the open stake.',
  'Eine Systemwette braucht 3 bis 8 Auswahlen.': 'A system bet needs 3 to 8 selections.',
  'Ein Boost wird als Einzelwette gespielt.': 'A boost is played as a single.',
  'Eine andere Wette wird gerade verarbeitet. Bitte erneut versuchen.':
    'Another bet is being processed. Please try again.',
  'Eine andere Wette wird gerade verarbeitet. Bitte versuche es erneut.':
    'Another bet is being processed. Please try again.',
  'Es besteht bereits eine gleich lange oder längere Selbstsperre.':
    'A self-exclusion of the same or longer length already exists.',
  'Es ist ein unerwarteter Fehler aufgetreten. Bitte versuche es erneut.':
    'An unexpected error occurred. Please try again.',
  'Event nicht gefunden.': 'Event not found.',
  'Falls ein Konto mit dieser Adresse existiert, haben wir eine E-Mail gesendet.':
    'If an account with this address exists, we have sent an email.',
  'Für Bet Builder gibt es keinen Cashout.': 'There is no cashout for Bet Builder bets.',
  'Für Boosts gibt es keinen Cashout.': 'There is no cashout for boosts.',
  'Für Systemwetten gibt es keinen Cashout.': 'There is no cashout for system bets.',
  'Für diese Aktion fehlt dir die Berechtigung.': 'You are not allowed to do this.',
  'Für dieses Event werden keine Wetten mehr angenommen.':
    'Bets are no longer accepted for this event.',
  'Für dieses Spiel gibt es keinen Bet Builder.': 'There is no Bet Builder for this match.',
  'Für dieses Spiel ist gerade kein Bet Builder verfügbar.':
    'No Bet Builder is available for this match right now.',
  'Gewinnchance und Richtung fehlen.': 'Win chance and direction missing.',
  'Hand nicht gefunden.': 'Hand not found.',
  'Hand und Schritt fehlen.': 'Hand and step missing.',
  'Höchstens 8 Auswahlen in einer Systemwette': 'At most 8 selections in a system bet',
  'Höchstens drei Nachkommastellen': 'At most three decimal places',
  'Im Bet Builder müssen alle Auswahlen aus demselben Spiel sein.':
    'In the Bet Builder all selections must be from the same match.',
  'Jede Auswahl darf nur einmal vorkommen': 'Each selection may only appear once',
  'Jede Seite nur einmal setzen.': 'Bet on each side only once.',
  'Karten sind für dieses Spiel nicht im Bet Builder verfügbar.':
    'Cards are not available in the Bet Builder for this match.',
  'Kein Cashout-Wert verfügbar.': 'No cashout value available.',
  'Mindestens ein Buchstabe und eine Ziffer': 'At least one letter and one digit',
  'Mindestens drei Auswahlen': 'At least three selections',
  'Mindestens eine Auswahl': 'At least one selection',
  'Mindestens zwei Auswahlen': 'At least two selections',
  'Mit dieser E-Mail-Adresse ist bereits ein Konto registriert. Melde dich an oder setze dein Passwort zurück.':
    'An account is already registered with this email address. Log in or reset your password.',
  'Nur Buchstaben, Ziffern, Leerzeichen, Punkt, Binde- und Unterstrich':
    'Only letters, digits, spaces, dots, hyphens and underscores',
  'Passwort ist falsch': 'Password is wrong',
  'Pro Markt ist nur eine Auswahl möglich.': 'Only one selection per market is possible.',
  'Quote ist unrealistisch hoch': 'Odds are unrealistically high',
  'Quote muss größer als 1 sein': 'Odds must be greater than 1',
  'Quote wurde aktualisiert.': 'Odds were updated.',
  'Runde nicht gefunden.': 'Round not found.',
  'Runde und Schritt fehlen.': 'Round and step missing.',
  'Sicherheitstoken fehlt oder ist abgelaufen. Bitte lade die Seite neu.':
    'Security token missing or expired. Please reload the page.',
  'Sicherheitstoken ist ungültig. Bitte lade die Seite neu.':
    'Security token is invalid. Please reload the page.',
  'Sitzung nicht gefunden.': 'Session not found.',
  'Spiel nicht gefunden.': 'Game not found.',
  'Spieleanbieter nicht verfügbar.': 'Game provider not available.',
  'Ungültige Auswahl': 'Invalid selection',
  'Ungültige Herkunft der Anfrage.': 'Invalid request origin.',
  'Ungültige ID': 'Invalid ID',
  'Ungültige Roulette-Wette.': 'Invalid roulette bet.',
  'Ungültiger Code': 'Invalid code',
  'Ungültiger Einsatz.': 'Invalid stake.',
  'Ungültiger Seitenverweis.': 'Invalid page reference.',
  'Ungültiger Wert': 'Invalid value',
  'Ungültiges Datum': 'Invalid date',
  'Ungültiges Format': 'Invalid format',
  'Unbekannte Aktion.': 'Unknown action.',
  'Verdoppeln ist nur mit den ersten zwei Karten möglich.':
    'Doubling is only possible with the first two cards.',
  'Wette nicht gefunden.': 'Bet not found.',
  'Wetten auf dieses Event sind vorübergehend gesperrt.':
    'Betting on this event is temporarily suspended.',
  'Wähle 1 bis 10 Zahlen.': 'Choose 1 to 10 numbers.',
  'Wähle 1 bis 10 verschiedene Zahlen von 1 bis 40.':
    'Choose 1 to 10 different numbers from 1 to 40.',
  'Zu viele Anfragen. Bitte warte einen Moment.': 'Too many requests. Please wait a moment.',
  'Zu viele fehlgeschlagene Anmeldeversuche. Bitte versuche es später erneut oder setze dein Passwort zurück.':
    'Too many failed login attempts. Please try again later or reset your password.',
  'Zugriff von dieser Adresse nicht erlaubt.': 'Access from this address is not allowed.',
  'Das Feld hat sich geändert. Bitte neu laden.': 'The board has changed. Please reload.',
  'Das Passwort muss mindestens 10 Zeichen lang sein':
    'The password must be at least 10 characters long',
  'Auswahl nicht mehr verfügbar.': 'Selection no longer available.',
};

const PATTERNS: [RegExp, string][] = [
  [/^1 bis (\d+) Einsätze pro Runde\.$/, '1 to $1 stakes per round.'],
  [
    /^Dein Limit „(.+)“ \((.+)\) wäre überschritten\. Verbleibend: (.+)\.$/,
    'Your limit “$1” ($2) would be exceeded. Remaining: $3.',
  ],
  [/^Der Höchsteinsatz beträgt (.+)\.$/, 'The maximum stake is $1.'],
  [/^Der Mindesteinsatz beträgt (.+)\.$/, 'The minimum stake is $1.'],
  [
    /^Der Mindesteinsatz pro Kombination beträgt (.+)\.$/,
    'The minimum stake per combination is $1.',
  ],
  [
    /^Der Zielwert darf den möglichen Gewinn \((.+)\) nicht übersteigen\.$/,
    'The target must not exceed the potential return ($1).',
  ],
  [
    /^Der maximale Gewinn beträgt (.+)\. Höchstmöglicher Einsatz: (.+)\.$/,
    'The maximum win is $1. Highest possible stake: $2.',
  ],
  [/^Die Gesamtquote darf (.+) nicht übersteigen\.$/, 'Total odds must not exceed $1.'],
  [
    /^Eine Aufladung ist erst möglich, wenn weniger als (.+) verfügbar sind\.$/,
    'A top-up is only possible when less than $1 is available.',
  ],
  [/^Einsatz muss zwischen (.+) und (.+) liegen\.$/, 'The stake must be between $1 and $2.'],
  [/^Höchsteinsatz für diesen Boost: (.+)\.$/, 'Maximum stake for this boost: $1.'],
  [/^Höchstens (\d+) Auswahlen im Bet Builder\.?$/, 'At most $1 selections in the Bet Builder'],
  [/^Höchstens (\d+) Auswahlen pro Wettschein\.$/, 'At most $1 selections per bet slip.'],
  [/^Höchstens (\d+) Auswahlen$/, 'At most $1 selections'],
  [/^Höchstens (\d+) Einträge$/, 'At most $1 entries'],
  [/^Höchstens (\d+) Zeichen$/, 'At most $1 characters'],
  [/^Mindestens (\d+) Einträge$/, 'At least $1 entries'],
  [/^Mindestens (\d+) Zeichen$/, 'At least $1 characters'],
  [/^Darf höchstens (.+) sein$/, 'Must be at most $1'],
  [/^Wähle ein System von 2 bis (\d+) aus (\d+)\.$/, 'Choose a system from 2 to $1 of $2.'],
  [/^„(.+)“ ist im Bet Builder nicht verfügbar\.$/, '“$1” is not available in the Bet Builder.'],
  [
    /^„(.+)“ ist im Live-Bet-Builder nicht verfügbar \(nur Märkte fürs ganze Spiel\)\.$/,
    '“$1” is not available in the live Bet Builder (full-match markets only).',
  ],
  [/^(.+) erreicht\.$/, '$1 reached.'],
  [/^Selbstsperre aktiv bis (.+)\.$/, 'Self-exclusion active until $1.'],
  [/^Selbstsperre aktiv\.$/, 'Self-exclusion active.'],
];

export function wantsEnglish(request: FastifyRequest): boolean {
  return request.cookies?.lang === 'en';
}

export function toEnglish(text: string): string {
  const exact = EN[text];
  if (exact) return exact;
  for (const [pattern, replace] of PATTERNS)
    if (pattern.test(text)) return text.replace(pattern, replace);
  return text;
}
