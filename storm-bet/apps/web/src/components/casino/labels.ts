import type { CasinoGameType } from '@storm-bet/types';

export const GAME_TYPE_LABELS: Record<CasinoGameType, string> = {
  SLOT: 'Slot',
  ROULETTE: 'Roulette',
  BLACKJACK: 'Blackjack',
  BACCARAT: 'Baccarat',
  CRASH: 'Crash',
  PLINKO: 'Plinko',
  MINES: 'Mines',
};

export const DEMO_MODE_LABEL = 'DEMO MODE – No real money';
