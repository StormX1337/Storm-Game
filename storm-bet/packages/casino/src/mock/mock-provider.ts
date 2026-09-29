import type { CasinoLaunch, CasinoProvider } from '../provider';
import { MOCK_CATEGORIES, MOCK_GAMES } from './catalog';

/** Runs the whole casino on this server with play money; no external supplier. */
export class MockCasinoProvider implements CasinoProvider {
  readonly key = 'mock';
  readonly name = 'STORM Games (Demo)';
  readonly isSimulated = true;
  readonly serverRounds = true;

  async getGames() {
    return MOCK_GAMES;
  }

  async getGame(externalId: string) {
    return MOCK_GAMES.find((g) => g.externalId === externalId) ?? null;
  }

  async getCategories() {
    return MOCK_CATEGORIES;
  }

  async createDemoSession(): Promise<CasinoLaunch> {
    return { kind: 'internal' };
  }

  async closeSession(): Promise<void> {
    // Nothing held outside this server.
  }
}
