import type { ProviderCasinoCategory, ProviderCasinoGame } from '../provider';
import { BACCARAT_RTP } from '../games/baccarat';
import { BLACKJACK_RTP } from '../games/blackjack';
import { CRASH_RTP } from '../games/crash';
import { MINES_RTP } from '../games/mines';
import { plinkoRtp } from '../games/plinko';
import { ROULETTE_RTP } from '../games/roulette';
import { SLOT_RTP } from '../games/slots';

/** Original game names and artwork parameters; no third-party titles or designs. */
export const MOCK_CATEGORIES: ProviderCasinoCategory[] = [
  { key: 'slots', name: 'Slots', sortOrder: 10 },
  { key: 'roulette', name: 'Roulette', sortOrder: 20 },
  { key: 'blackjack', name: 'Blackjack', sortOrder: 30 },
  { key: 'baccarat', name: 'Baccarat', sortOrder: 40 },
  { key: 'table-games', name: 'Tischspiele', sortOrder: 50 },
  { key: 'live-casino', name: 'Live Casino', sortOrder: 60 },
  { key: 'instant', name: 'Sofortspiele', sortOrder: 15 },
];

const slot = (
  n: number,
  slug: string,
  name: string,
  description: string,
  theme: ProviderCasinoGame['theme'],
  flags: Partial<ProviderCasinoGame> = {},
): ProviderCasinoGame => ({
  externalId: slug,
  slug,
  name,
  type: 'SLOT',
  categories: ['slots'],
  description,
  minStake: 10,
  maxStake: 10_000,
  rtp: SLOT_RTP,
  theme,
  isFeatured: false,
  isNew: false,
  sortOrder: n,
  ...flags,
});

const table = (
  n: number,
  slug: string,
  name: string,
  type: ProviderCasinoGame['type'],
  categories: string[],
  description: string,
  theme: ProviderCasinoGame['theme'],
  flags: Partial<ProviderCasinoGame> = {},
): ProviderCasinoGame => ({
  externalId: slug,
  slug,
  name,
  type,
  categories,
  description,
  minStake: 10,
  maxStake: 50_000,
  rtp: type === 'ROULETTE' ? ROULETTE_RTP : type === 'BLACKJACK' ? BLACKJACK_RTP : BACCARAT_RTP,
  theme,
  isFeatured: false,
  isNew: false,
  sortOrder: n,
  ...flags,
});

const AUTO = 'Automatisierter Tisch ohne Live-Dealer und ohne Videostream – Ergebnisse vom Server.';

/** Instant games: one decision, the server's result at once (Mines: step by step). */
const instant = (
  n: number,
  slug: string,
  name: string,
  type: 'CRASH' | 'PLINKO' | 'MINES',
  rtp: number,
  description: string,
  theme: ProviderCasinoGame['theme'],
): ProviderCasinoGame => ({
  externalId: slug,
  slug,
  name,
  type,
  categories: ['instant'],
  description,
  minStake: 10,
  maxStake: 10_000,
  rtp: Math.round(rtp * 10_000) / 100,
  theme,
  isFeatured: true,
  isNew: true,
  sortOrder: n,
});

export const MOCK_GAMES: ProviderCasinoGame[] = [
  instant(
    5,
    'storm-crash',
    'Storm Crash',
    'CRASH',
    CRASH_RTP,
    'Der Multiplikator steigt, bis er abstürzt. Lege vorher fest, bei welchem Wert du aussteigst.',
    { from: '#0f172a', to: '#7c3aed', accent: '#f472b6', motif: 'rocket' },
  ),
  instant(
    6,
    'storm-mines',
    'Storm Mines',
    'MINES',
    MINES_RTP,
    '5×5 Felder, du wählst die Zahl der Minen. Jedes sichere Feld erhöht den Gewinn – steig rechtzeitig aus.',
    { from: '#052e16', to: '#0d9488', accent: '#fde047', motif: 'bomb' },
  ),
  instant(
    7,
    'storm-plinko',
    'Storm Plinko',
    'PLINKO',
    Math.min(plinkoRtp('low'), plinkoRtp('medium'), plinkoRtp('high')),
    'Die Kugel fällt durch 12 Reihen Stifte in ein Gewinnfach. Drei Risikostufen.',
    { from: '#172554', to: '#2563eb', accent: '#fb923c', motif: 'pegs' },
  ),
  slot(
    10,
    'storm-surge',
    'Storm Surge',
    'Blitze über fünf Walzen, zehn Gewinnlinien.',
    { from: '#1e3a8a', to: '#0ea5e9', accent: '#facc15', motif: 'bolt' },
    { isFeatured: true },
  ),
  slot(
    20,
    'neon-nebula',
    'Neon Nebula',
    'Kosmische Symbole in Neonfarben.',
    { from: '#4c1d95', to: '#db2777', accent: '#67e8f9', motif: 'star' },
    { isNew: true },
  ),
  slot(
    30,
    'golden-tempest',
    'Golden Tempest',
    'Kronen und Edelsteine im goldenen Sturm.',
    { from: '#78350f', to: '#f59e0b', accent: '#fde68a', motif: 'crown' },
    { isFeatured: true },
  ),
  slot(40, 'aurora-gems', 'Aurora Gems', 'Polarlicht-Edelsteine auf fünf Walzen.', {
    from: '#064e3b',
    to: '#10b981',
    accent: '#a7f3d0',
    motif: 'gem',
  }),
  slot(
    50,
    'tidal-treasure',
    'Tidal Treasure',
    'Schätze aus der Tiefsee.',
    { from: '#0c4a6e', to: '#06b6d4', accent: '#fef08a', motif: 'wave' },
    { isNew: true },
  ),
  slot(60, 'midnight-orchard', 'Midnight Orchard', 'Klassische Früchte unter dem Mond.', {
    from: '#1f2937',
    to: '#7c3aed',
    accent: '#fca5a5',
    motif: 'moon',
  }),
  table(
    110,
    'storm-roulette',
    'Storm Roulette',
    'ROULETTE',
    ['roulette', 'table-games'],
    'Europäisches Roulette mit einer Null.',
    { from: '#7f1d1d', to: '#dc2626', accent: '#fde047', motif: 'wheel' },
    { isFeatured: true },
  ),
  table(
    120,
    'midnight-roulette',
    'Midnight Roulette',
    'ROULETTE',
    ['roulette', 'table-games'],
    'Europäisches Roulette im Nachtdesign.',
    { from: '#111827', to: '#b91c1c', accent: '#e5e7eb', motif: 'wheel' },
  ),
  table(
    210,
    'blackjack-classic',
    'Blackjack Classic',
    'BLACKJACK',
    ['blackjack', 'table-games'],
    '6 Decks, Dealer steht auf Soft 17, Blackjack zahlt 3:2.',
    { from: '#14532d', to: '#16a34a', accent: '#fef3c7', motif: 'cards' },
    { isFeatured: true },
  ),
  table(
    220,
    'blackjack-nova',
    'Blackjack Nova',
    'BLACKJACK',
    ['blackjack', 'table-games'],
    'Blackjack mit modernem Tisch.',
    { from: '#1e1b4b', to: '#4f46e5', accent: '#c7d2fe', motif: 'cards' },
    { isNew: true },
  ),
  table(
    310,
    'baccarat-royale',
    'Baccarat Royale',
    'BACCARAT',
    ['baccarat', 'table-games'],
    'Punto Banco mit 8 Decks.',
    { from: '#4a044e', to: '#a21caf', accent: '#fbcfe8', motif: 'chip' },
  ),
  table(
    320,
    'punto-banco-storm',
    'Punto Banco Storm',
    'BACCARAT',
    ['baccarat', 'table-games'],
    'Schnelles Punto Banco.',
    { from: '#172554', to: '#0891b2', accent: '#fef9c3', motif: 'chip' },
  ),
  table(410, 'auto-roulette', 'Auto Roulette', 'ROULETTE', ['live-casino', 'roulette'], AUTO, {
    from: '#450a0a',
    to: '#991b1b',
    accent: '#fecaca',
    motif: 'wheel',
  }),
  table(420, 'speed-baccarat', 'Speed Baccarat', 'BACCARAT', ['live-casino', 'baccarat'], AUTO, {
    from: '#3b0764',
    to: '#7e22ce',
    accent: '#e9d5ff',
    motif: 'chip',
  }),
];
