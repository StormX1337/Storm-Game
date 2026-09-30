import { EN } from './en';

type Replace = string | ((...m: string[]) => string);

const WEEKDAYS: Record<string, string> = {
  Mo: 'Mon',
  Di: 'Tue',
  Mi: 'Wed',
  Do: 'Thu',
  Fr: 'Fri',
  Sa: 'Sat',
  So: 'Sun',
};
const UNITS: Record<string, string> = {
  Sekunde: 'second',
  Sekunden: 'seconds',
  Minute: 'minute',
  Minuten: 'minutes',
  Stunde: 'hour',
  Stunden: 'hours',
  Tag: 'day',
  Tagen: 'days',
  Tage: 'days',
};

const FIGURES: Record<string, string> = {
  Punkte: 'points',
  Rebounds: 'rebounds',
  Assists: 'assists',
  Dreier: 'threes',
  'Schüsse aufs Tor': 'shots on target',
  'Punkte+Rebounds+Assists': 'points+rebounds+assists',
  Tore: 'goals',
};

/** Texts with numbers or names in them (tried after the exact table). */
export const EN_PATTERNS: [RegExp, Replace][] = [
  [/^Heute (\d\d:\d\d)$/, 'Today $1'],
  [/^Morgen (\d\d:\d\d)$/, 'Tomorrow $1'],
  [
    /^(Mo|Di|Mi|Do|Fr|Sa|So)\., (\d\d)\.(\d\d)\.(.*)$/,
    (_m, d: string, day: string, month: string, rest: string) =>
      `${WEEKDAYS[d] ?? d} ${day}/${month}${rest}`,
  ],
  [/^vor (\d+) (\w+)$/, (_m, n: string, u: string) => `${n} ${UNITS[u] ?? u} ago`],
  [/^in (\d+) (\w+)$/, (_m, n: string, u: string) => `in ${n} ${UNITS[u] ?? u}`],
  // Selection names from the book.
  [/^Über (\S+)$/, 'Over $1'],
  [/^Unter (\S+)$/, 'Under $1'],
  [/^(.+) oder Unentschieden$/, '$1 or draw'],
  [/^Unentschieden oder (.+)$/, 'Draw or $1'],
  [
    /^(.+) – (.+) (Über|Unter) (\S+)$/,
    (_m, who: string, what: string, side: string, line: string) =>
      `${who} – ${FIGURES[what] ?? what} ${side === 'Über' ? 'over' : 'under'} ${line}`,
  ],
  [/^(.+) gewinnt$/, '$1 to win'],
  [/^(.+) oder (.+)$/, '$1 or $2'],
  [/^Cashout: (.+)$/, 'Cashout: $1'],
  [/^Auto-Cashout: (.+)$/, 'Auto cashout: $1'],
  // Transaction descriptions from the ledger.
  [/^Einsatz reserviert · (.+)$/, 'Stake reserved · $1'],
  [/^Gewinn ausgezahlt · (.+)$/, 'Winnings paid · $1'],
  [/^Wette verloren · (.+)$/, 'Bet lost · $1'],
  [/^Wette storniert – Einsatz zurück · (.+)$/, 'Bet void – stake returned · $1'],
  [/^Wette storniert \(Erstattung\) · (.+)$/, 'Bet void (refund) · $1'],
  [/^Teil-Cashout · (.+)$/, 'Partial cashout · $1'],
  [/^Cashout · (.+)$/, 'Cashout · $1'],
  [/^Casino: (.+) \(verdoppelt\)$/, 'Casino: $1 (doubled)'],
  [/^Casino-Gewinn: (.+)$/, (_m, g: string) => `Casino win: ${EN[g] ?? g}`],
  [/^Casino-Erstattung: (.+)$/, (_m, g: string) => `Casino refund: ${EN[g] ?? g}`],
  [/^Casino: (.+)$/, (_m, g: string) => `Casino: ${EN[g] ?? g}`],
  [/^Mindestens (\d+) Zeichen$/, 'At least $1 characters'],
  [/^Höchstens (\d+) Zeichen$/, 'At most $1 characters'],
  [/^jetzt$/, 'now'],
  [/^gestern$/, 'yesterday'],
  [/^vorgestern$/, 'the day before yesterday'],
  [/^heute$/, 'today'],
  [/^morgen$/, 'tomorrow'],
];
