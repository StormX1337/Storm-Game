import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { NA, num, pct } from '@/lib/format';
import type { ScheduleInfo, Squad, Tactics } from '@/lib/types';

function SquadColumn({ name, squad }: { name: string; squad: Squad }) {
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{name}</span>
        {squad.lineup_confirmed ? (
          <Badge>Line-up confirmed</Badge>
        ) : (
          <Badge variant="secondary">Expected line-up not confirmed</Badge>
        )}
        {!squad.injuries_known && <Badge variant="destructive">Absences unknown</Badge>}
      </div>
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Injured / suspended
        </div>
        {squad.injuries.length === 0 ? (
          <p className="text-muted-foreground">{squad.injuries_known ? 'None reported' : NA}</p>
        ) : (
          <ul className="space-y-0.5">
            {squad.injuries.map((i) => (
              <li key={`${i.player}-${i.type}`} className="flex justify-between gap-2">
                <span>{i.player}</span>
                <span className="text-xs text-muted-foreground">
                  {i.type ?? ''}
                  {i.reason ? ` · ${i.reason}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {squad.returning_players.length > 0 && (
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Returning
          </div>
          <p>{squad.returning_players.join(', ')}</p>
        </div>
      )}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <div className="text-muted-foreground">Missing goal contributions</div>
          <div className="num font-semibold">{pct(squad.missing_goal_share, 0)}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Regular defenders/GK missing</div>
          <div className="num font-semibold">{squad.missing_key_defenders}</div>
        </div>
      </div>
      {squad.contributors.length > 0 && (
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Key contributors (goals + assists, recent matches)
          </div>
          <ul className="space-y-0.5">
            {squad.contributors.map((c) => (
              <li key={c.player} className="flex justify-between gap-2">
                <span className={c.missing ? 'text-signal-avoid line-through' : ''}>
                  {c.player}
                </span>
                <span className="num text-xs">{c.contributions}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {squad.lineup && squad.lineup.start_xi.length > 0 && (
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Starting XI {squad.lineup.formation ? `(${squad.lineup.formation})` : ''}
          </div>
          <p className="text-xs leading-relaxed">
            {squad.lineup.start_xi.map((p) => `${p.name}${p.pos ? ` (${p.pos})` : ''}`).join(', ')}
          </p>
        </div>
      )}
    </div>
  );
}

export function SquadCard({
  home,
  away,
  homeName,
  awayName,
}: {
  home: Squad;
  away: Squad;
  homeName: string;
  awayName: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Squad</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-6 md:grid-cols-2">
        <SquadColumn name={homeName} squad={home} />
        <SquadColumn name={awayName} squad={away} />
      </CardContent>
    </Card>
  );
}

function row(label: string, h: string, a: string) {
  return (
    <div
      key={label}
      className="grid grid-cols-[1.3fr_1fr_1fr] gap-2 border-b py-1.5 text-sm last:border-0"
    >
      <span className="text-muted-foreground">{label}</span>
      <span className="num">{h}</span>
      <span className="num">{a}</span>
    </div>
  );
}

export function TacticsCard({
  home,
  away,
  hs,
  as_,
  homeName,
  awayName,
}: {
  home: Tactics;
  away: Tactics;
  hs: ScheduleInfo | null;
  as_: ScheduleInfo | null;
  homeName: string;
  awayName: string;
}) {
  const rest = (s: ScheduleInfo | null) =>
    s?.rest_days == null ? NA : `${num(s.rest_days, 1)} days`;
  const rotation = (s: ScheduleInfo | null) => {
    if (!s || s.rest_days == null) return NA;
    return s.rest_days < 4 || s.matches_last_7 >= 2 ? 'Elevated' : 'Normal';
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Tactics & schedule</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-[1.3fr_1fr_1fr] gap-2 border-b pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <span />
          <span className="truncate">{homeName}</span>
          <span className="truncate">{awayName}</span>
        </div>
        {row('Formation', home.formation ?? NA, away.formation ?? NA)}
        {row(
          'Possession',
          home.possession == null ? NA : `${home.possession.toFixed(0)}%`,
          away.possession == null ? NA : `${away.possession.toFixed(0)}%`,
        )}
        {row('Shots / game', num(home.shots_per_game, 1), num(away.shots_per_game, 1))}
        {row('Style', home.style ?? NA, away.style ?? NA)}
        {row('Pressing', NA, NA)}
        {row('Defensive line', NA, NA)}
        {row('Counter attacks', NA, NA)}
        {row('Rest before match', rest(hs), rest(as_))}
        {row(
          'Matches last 7 days',
          String(hs?.matches_last_7 ?? NA),
          String(as_?.matches_last_7 ?? NA),
        )}
        {row(
          'Matches last 14 days',
          String(hs?.matches_last_14 ?? NA),
          String(as_?.matches_last_14 ?? NA),
        )}
        {row('Travel', NA, NA)}
        {row('Rotation risk', rotation(hs), rotation(as_))}
        <p className="mt-2 text-[11px] text-muted-foreground">
          Pressing, defensive line, counter-attack and travel data are not provided by the
          configured sources and are therefore N/A. Style is derived from possession only.
        </p>
      </CardContent>
    </Card>
  );
}
