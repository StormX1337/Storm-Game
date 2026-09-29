import type { SportKey } from '@storm-bet/types';

/**
 * Fictional competitions, clubs and players. Every name is invented so that
 * simulated fixtures can never be mistaken for real matches.
 */

export interface MockLeagueDef {
  id: string;
  sport: SportKey;
  name: string;
  country: string;
  /** A new round kicks off every `slotMinutes` of real time… */
  slotMinutes: number;
  /** …with this many fixtures, staggered by `staggerMinutes`. */
  fixturesPerSlot: number;
  staggerMinutes: number;
  /** Shifts the league's rounds so leagues do not all start together. */
  offsetMinutes: number;
  teams: string[];
}

export const MOCK_SPORTS: { key: SportKey; name: string }[] = [
  { key: 'football', name: 'Fußball' },
  { key: 'tennis', name: 'Tennis' },
  { key: 'basketball', name: 'Basketball' },
];

export const MOCK_LEAGUES: MockLeagueDef[] = [
  {
    id: 'fb-nordliga',
    sport: 'football',
    name: 'Nordliga',
    country: 'Demo-Land',
    slotMinutes: 90,
    fixturesPerSlot: 2,
    staggerMinutes: 15,
    offsetMinutes: 0,
    teams: [
      'FC Nordhafen',
      'SV Bergstadt',
      'Union Eichwald',
      'Athletic Weserau',
      'Blau-Weiß Kronach',
      'TSV Falkenried',
      'Borussia Lindental',
      'Eintracht Seefeld',
      'VfR Sturmbach',
      'Rot-Gelb Altmark',
      'SC Mühlenbrück',
      'FSV Kieselberg',
    ],
  },
  {
    id: 'fb-liga-costa',
    sport: 'football',
    name: 'Liga Costa',
    country: 'Demo-Land',
    slotMinutes: 90,
    fixturesPerSlot: 2,
    staggerMinutes: 20,
    offsetMinutes: 30,
    teams: [
      'Real Solvento',
      'Sporting Castellar',
      'Atlético Marbella Norte',
      'CD Pinaroca',
      'Unión Vallesur',
      'Racing Almadora',
      'Deportivo Ribalta',
      'CF Montecillo',
      'Club Arenaluz',
      'Olímpico Serrano',
    ],
  },
  {
    id: 'fb-continental-cup',
    sport: 'football',
    name: 'Continental Cup',
    country: 'International',
    slotMinutes: 90,
    fixturesPerSlot: 2,
    staggerMinutes: 10,
    offsetMinutes: 60,
    teams: [
      'AC Valmonte',
      'Dynamo Korvik',
      'Ajax Veldhoven',
      'Lions of Harwick',
      'Olympique Rivesaltes',
      'Sparta Brodnik',
      'Rapid Talheim',
      'FK Zelenogorsk',
      'Hibernia Glenmoor',
      'Benfica do Porto Alto',
      'Galata Istanza',
      'Celtic Dunmore',
    ],
  },
  {
    id: 'tn-demo-open',
    sport: 'tennis',
    name: 'Storm Open (Herren)',
    country: 'International',
    slotMinutes: 50,
    fixturesPerSlot: 2,
    staggerMinutes: 10,
    offsetMinutes: 5,
    teams: [
      'L. Varga',
      'M. Okafor',
      'T. Lindqvist',
      'R. Castellano',
      'J. Moreau',
      'K. Takeda',
      'A. Novak',
      'D. Whitfield',
      'S. Petrescu',
      'E. Ramírez',
      'P. Holm',
      'N. Brandt',
      'I. Kovalenko',
      'F. Lambert',
    ],
  },
  {
    id: 'tn-coastal-classic',
    sport: 'tennis',
    name: 'Coastal Classic (Damen)',
    country: 'International',
    slotMinutes: 50,
    fixturesPerSlot: 2,
    staggerMinutes: 15,
    offsetMinutes: 30,
    teams: [
      'A. Sørensen',
      'C. Duarte',
      'M. Ivanova',
      'H. Nakamura',
      'L. Fontaine',
      'G. Schneider',
      'V. Esposito',
      'Z. Adeyemi',
      'O. Kowalczyk',
      'B. Hartmann',
      'Y. Chen',
      'R. Almeida',
    ],
  },
  {
    id: 'bb-continental',
    sport: 'basketball',
    name: 'Continental Basketball League',
    country: 'International',
    slotMinutes: 60,
    fixturesPerSlot: 2,
    staggerMinutes: 15,
    offsetMinutes: 15,
    teams: [
      'Bergstadt Titans',
      'Harbor City Waves',
      'Nordhafen Storm Riders',
      'Valmonte Falcons',
      'Kronach Bears',
      'Solvento Suns',
      'Glenmoor Highlanders',
      'Korvik Wolves',
      'Altmark Giants',
      'Arenaluz Comets',
    ],
  },
];

const FIRST = [
  'Jonas',
  'Mateo',
  'Luca',
  'Nils',
  'Emil',
  'Tiago',
  'Rafael',
  'Oskar',
  'Milan',
  'Aaron',
  'Levin',
  'Samuel',
  'Noah',
  'Elias',
  'Joel',
  'Dario',
  'Marek',
  'Tomás',
  'Kian',
  'Ilias',
];
const LAST = [
  'Albrecht',
  'Brenner',
  'Costa',
  'Dietz',
  'Engel',
  'Ferreira',
  'Grund',
  'Haller',
  'Iversen',
  'Janek',
  'Kessler',
  'Lorenz',
  'Moreno',
  'Nowak',
  'Ortega',
  'Pohl',
  'Quint',
  'Reiter',
  'Silva',
  'Thaler',
  'Urban',
  'Vogt',
  'Weller',
  'Yilmaz',
  'Zander',
];

export type PlayerPosition = 'GK' | 'DF' | 'MF' | 'FW';

/** Positions of the eleven players a mock football squad lists. */
export const SQUAD_POSITIONS: PlayerPosition[] = [
  'GK',
  'DF',
  'DF',
  'DF',
  'DF',
  'MF',
  'MF',
  'MF',
  'FW',
  'FW',
  'FW',
];

export const FIRST_NAMES = FIRST;
export const LAST_NAMES = LAST;

export function shortName(name: string): string {
  const words = name
    .replace(/[^\p{L} ]/gu, '')
    .split(/\s+/)
    .filter(Boolean);
  const main = words.reduce((a, b) => (b.length > a.length ? b : a), '');
  return main.slice(0, 3).toUpperCase();
}
