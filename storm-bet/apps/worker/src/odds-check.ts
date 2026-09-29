import { parseEnv, workerEnvSchema } from '@storm-bet/config';
import { SportsGameOddsProvider, TheOddsApiProvider } from '@storm-bet/odds-engine';
import { createInnerProvider } from './provider';

/**
 * `pnpm --filter @storm-bet/worker odds:check` — verifies the configured feed:
 * reachable, key accepted, which competitions would be imported and how much
 * quota remains. Listing competitions costs nothing; pass --with-odds to also
 * fetch odds (costs credits / event objects).
 */
async function main(): Promise<void> {
  const env = parseEnv(workerEnvSchema);
  const provider = createInnerProvider(env);
  console.log(
    `Provider: ${provider.name} (${provider.key})${provider.isSimulated ? ' – simuliert' : ''}`,
  );
  const leagues = await provider.getLeagues();
  console.log(`Wettbewerbe (${leagues.length}):`);
  for (const l of leagues)
    console.log(`  ${l.sportKey.padEnd(10)} ${l.externalId.padEnd(36)} ${l.name}`);
  if (process.argv.includes('--with-odds') && leagues[0]) {
    const events = await provider.getEvents({
      sportKey: leagues[0].sportKey,
      from: new Date(Date.now() - 6 * 3_600_000).toISOString(),
      to: new Date(Date.now() + 7 * 24 * 3_600_000).toISOString(),
    });
    console.log(`\n${events.length} Events, z. B.:`);
    for (const e of events.slice(0, 5)) {
      const markets = await provider.getMarkets(e.externalId);
      console.log(
        `  ${e.startTime}  ${e.home.name} – ${e.away.name}  [${markets.map((m) => m.key).join(', ')}]`,
      );
    }
  }
  if (provider instanceof TheOddsApiProvider || provider instanceof SportsGameOddsProvider) {
    const q =
      provider instanceof SportsGameOddsProvider ? await provider.loadQuota() : provider.getQuota();
    const unit = provider instanceof TheOddsApiProvider ? 'Credits' : 'Event-Objekte (Monat)';
    console.log(`\n${unit}: verbleibend ${q.remaining ?? '?'}, verbraucht ${q.used ?? '?'}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
