/**
 * What the platform knows about each feed, for labelling. A feed is treated
 * as simulated unless it is listed here as observed data.
 */
export const PROVIDER_INFO: Record<string, { name: string; isSimulated: boolean }> = {
  mock: { name: 'STORM Simulator', isSimulated: true },
  manual: { name: 'Manuell (Staff)', isSimulated: true },
  theoddsapi: { name: 'The Odds API', isSimulated: false },
};

export function isSimulatedProvider(key: string): boolean {
  return PROVIDER_INFO[key]?.isSimulated ?? true;
}
