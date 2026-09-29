/**
 * Jurisdiction layer. Where a player may play depends on licences this demo
 * does not hold, so the only production-grade decision available today is
 * "demo play is allowed, real money is not". A licensed deployment plugs in
 * its own policy (licence list, geo-IP provider, VPN detection) here.
 */
export interface JurisdictionContext {
  /** ISO 3166-1 alpha-2 from the player's profile, if known. */
  country: string | null;
  /** Country resolved from the request IP by a geo provider, if configured. */
  ipCountry?: string | null;
}

export interface JurisdictionDecision {
  demoAllowed: boolean;
  realMoneyAllowed: boolean;
  reason: string | null;
}

export interface JurisdictionPolicy {
  evaluate(context: JurisdictionContext): JurisdictionDecision;
}

/** Demo play everywhere except explicitly blocked countries; never real money. */
export class DemoJurisdictionPolicy implements JurisdictionPolicy {
  private readonly blocked: Set<string>;

  constructor(blockedCountries: readonly string[] = []) {
    this.blocked = new Set(blockedCountries.map((c) => c.toUpperCase()));
  }

  evaluate({ country, ipCountry }: JurisdictionContext): JurisdictionDecision {
    const hit = [country, ipCountry].find((c) => c && this.blocked.has(c.toUpperCase()));
    return {
      demoAllowed: !hit,
      realMoneyAllowed: false,
      reason: hit
        ? `Angebot in ${hit} nicht verfügbar`
        : 'Echtgeld ist in dieser Version deaktiviert',
    };
  }
}
