import type { Pair } from '@storm-bet/types';
import { cn } from '@storm-bet/ui';

/**
 * A pitch or court behind the running score. It shows only what the data feed
 * reports (score, period, clock); there is no ball tracking, so nothing on it
 * pretends to show where the ball is.
 */
export function MatchField({
  sport,
  home,
  away,
  score,
  status,
  live,
}: {
  sport: 'football' | 'basketball';
  home: string;
  away: string;
  score: Pair;
  status: string;
  live: boolean;
}) {
  return (
    <div className="px-3 py-4 sm:px-6" data-testid="match-field">
      <div
        className={cn(
          'relative overflow-hidden rounded-lg border border-border',
          sport === 'football' ? 'bg-up-soft' : 'bg-warning-soft',
        )}
      >
        {sport === 'football' ? <Pitch /> : <Court />}
        <div className="absolute inset-0 grid grid-cols-[1fr_auto_1fr] items-center px-3 sm:px-6">
          <TeamLabel name={home} />
          <div className="rounded-lg border border-border bg-surface/90 px-4 py-2 text-center shadow-[var(--shadow-pop)] backdrop-blur">
            <p
              className="tabular text-3xl font-semibold tracking-tight sm:text-4xl"
              data-testid="score"
            >
              {score.home}
              <span className="px-1.5 text-fg-subtle">:</span>
              {score.away}
            </p>
            <p className={cn('text-xs', live ? 'text-live' : 'text-fg-muted')}>{status}</p>
          </div>
          <TeamLabel name={away} />
        </div>
      </div>
    </div>
  );
}

function TeamLabel({ name }: { name: string }) {
  return (
    <p className="line-clamp-2 text-center text-sm font-semibold text-fg sm:text-base">{name}</p>
  );
}

function Pitch() {
  return (
    <svg
      viewBox="0 0 120 80"
      className="block h-auto w-full text-border-strong"
      fill="none"
      stroke="currentColor"
      strokeWidth="0.5"
      aria-hidden="true"
    >
      <rect x="2" y="2" width="116" height="76" rx="1" />
      <line x1="60" y1="2" x2="60" y2="78" />
      <circle cx="60" cy="40" r="9.15" />
      <circle cx="60" cy="40" r="0.6" fill="currentColor" />
      <rect x="2" y="19.85" width="16.5" height="40.3" />
      <rect x="101.5" y="19.85" width="16.5" height="40.3" />
      <rect x="2" y="30.85" width="5.5" height="18.3" />
      <rect x="112.5" y="30.85" width="5.5" height="18.3" />
      <circle cx="13" cy="40" r="0.6" fill="currentColor" />
      <circle cx="107" cy="40" r="0.6" fill="currentColor" />
      <path d="M18.5 32.7 A9.15 9.15 0 0 1 18.5 47.3" />
      <path d="M101.5 32.7 A9.15 9.15 0 0 0 101.5 47.3" />
    </svg>
  );
}

function Court() {
  return (
    <svg
      viewBox="0 0 94 50"
      className="block h-auto w-full text-border-strong"
      fill="none"
      stroke="currentColor"
      strokeWidth="0.4"
      aria-hidden="true"
    >
      <rect x="1" y="1" width="92" height="48" rx="0.5" />
      <line x1="47" y1="1" x2="47" y2="49" />
      <circle cx="47" cy="25" r="6" />
      <rect x="1" y="17" width="19" height="16" />
      <rect x="74" y="17" width="19" height="16" />
      <circle cx="20" cy="25" r="6" />
      <circle cx="74" cy="25" r="6" />
      <path d="M1 3 H15 A23.75 23.75 0 0 1 15 47 H1" />
      <path d="M93 3 H79 A23.75 23.75 0 0 0 79 47 H93" />
      <circle cx="6.25" cy="25" r="0.75" />
      <circle cx="87.75" cy="25" r="0.75" />
    </svg>
  );
}
