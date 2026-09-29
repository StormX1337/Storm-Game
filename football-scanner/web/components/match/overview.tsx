import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { NA, num, pct, shortDate } from '@/lib/format';
import type { FormBlock, MatchAnalysis, NumMap, StatModel } from '@/lib/types';
import { cn } from '@/lib/utils';

function Letter({ r }: { r: string }) {
  const tone =
    r === 'W'
      ? 'bg-signal-strong text-white'
      : r === 'L'
        ? 'bg-signal-avoid text-white'
        : 'bg-muted-foreground/60 text-white';
  return (
    <span className={cn('grid h-5 w-5 place-items-center rounded text-[10px] font-bold', tone)}>
      {r}
    </span>
  );
}

export function FormStrip({ seq }: { seq?: string }) {
  if (!seq) return <span className="text-xs text-muted-foreground">{NA}</span>;
  return (
    <div className="flex gap-0.5">
      {seq.split('').map((r, i) => (
        <Letter key={i} r={r} />
      ))}
    </div>
  );
}

function formRows(f: FormBlock): [string, string][] {
  if (!f || !f.matches) return [['Matches', '0']];
  return [
    ['Record (W-D-L)', `${f.wins}-${f.draws}-${f.losses}`],
    ['Goals for / against', `${f.goals_for} / ${f.goals_against}`],
    ['Per game', `${num(f.goals_for_per_game)} / ${num(f.goals_against_per_game)}`],
    ['Points per game', num(f.points_per_game)],
    ['Clean sheets', String(f.clean_sheets ?? NA)],
    ['BTTS', pct(f.btts_rate, 0)],
    ['Over 1.5 / 2.5', `${pct(f.over_1_5_rate, 0)} / ${pct(f.over_2_5_rate, 0)}`],
    ['Under 2.5', pct(f.under_2_5_rate, 0)],
    ['Half-time results', f.ht_results ?? NA],
  ];
}

export function FormCompare({
  a,
  homeName,
  awayName,
}: {
  a: MatchAnalysis;
  homeName: string;
  awayName: string;
}) {
  const blocks: { key: 'last5' | 'last10' | 'last15' | 'venue'; label: string }[] = [
    { key: 'last5', label: 'Last 5' },
    { key: 'last10', label: 'Last 10' },
    { key: 'last15', label: 'Last 15' },
    { key: 'venue', label: 'Home form (home) / Away form (away)' },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Form</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {blocks.map(({ key, label }) => {
          const h = a.context.home.form[key];
          const w = a.context.away.form[key];
          const hr = formRows(h);
          const wr = formRows(w);
          return (
            <div key={key}>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {label}
              </div>
              <Table className="table-fixed">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-1/3" />
                    <TableHead>
                      <div className="flex flex-col gap-1 py-1">
                        <span className="truncate">{homeName}</span>
                        <FormStrip seq={h?.sequence} />
                      </div>
                    </TableHead>
                    <TableHead>
                      <div className="flex flex-col gap-1 py-1">
                        <span className="truncate">{awayName}</span>
                        <FormStrip seq={w?.sequence} />
                      </div>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {hr.map(([k, v], i) => (
                    <TableRow key={k}>
                      <TableCell className="text-muted-foreground">{k}</TableCell>
                      <TableCell className="num">{v}</TableCell>
                      <TableCell className="num">{wr[i]?.[1] ?? NA}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          );
        })}
        <p className="text-[11px] text-muted-foreground">
          First-goal and after-60′ splits need minute-by-minute events for every match; they show
          N/A when the data source does not provide them.
        </p>
      </CardContent>
    </Card>
  );
}

export function CompareTable({
  title,
  rows,
  home,
  away,
  homeName,
  awayName,
}: {
  title: string;
  rows: [string, string, (v: number | null | undefined) => string][];
  home: NumMap;
  away: NumMap;
  homeName: string;
  awayName: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <Table className="table-fixed">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[46%]">Last 10</TableHead>
              <TableHead className="truncate text-right" title={homeName}>
                {homeName}
              </TableHead>
              <TableHead className="truncate text-right" title={awayName}>
                {awayName}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(([label, key, fmt]) => (
              <TableRow key={key}>
                <TableCell className="text-muted-foreground">{label}</TableCell>
                <TableCell className="num text-right">{fmt(home[key])}</TableCell>
                <TableCell className="num text-right">{fmt(away[key])}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

const n2 = (v: number | null | undefined) => num(v, 2);
const p0 = (v: number | null | undefined) =>
  v === null || v === undefined ? NA : `${v.toFixed(0)}%`;
const r0 = (v: number | null | undefined) => pct(v, 0);

export const ATTACK_ROWS: [string, string, (v: number | null | undefined) => string][] = [
  ['Goals / game', 'goals_per_game', n2],
  ['xG / game', 'xg_per_game', n2],
  ['Shots / game', 'shots_per_game', n2],
  ['Shots on target / game', 'shots_on_target_per_game', n2],
  ['Conversion (goals / shots)', 'conversion_rate', r0],
  ['Possession', 'possession', p0],
  ['Big chances / game', 'big_chances_per_game', n2],
];

export const DEFENCE_ROWS: [string, string, (v: number | null | undefined) => string][] = [
  ['Conceded / game', 'conceded_per_game', n2],
  ['xGA / game', 'xga_per_game', n2],
  ['Clean sheet rate', 'clean_sheet_rate', r0],
  ['Shots conceded / game', 'shots_conceded_per_game', n2],
  ['On target conceded / game', 'shots_on_target_conceded_per_game', n2],
  ['Conceded 1st half / game', 'first_half_conceded_per_game', n2],
  ['Conceded 2nd half / game', 'second_half_conceded_per_game', n2],
  ['Defensive errors / game', 'defensive_errors_per_game', n2],
];

export const COUNT_ROWS: [string, string, (v: number | null | undefined) => string][] = [
  ['For / game', 'for_per_game', n2],
  ['Against / game', 'against_per_game', n2],
  ['At home: for / game', 'home_for_per_game', n2],
  ['At home: against / game', 'home_against_per_game', n2],
  ['Away: for / game', 'away_for_per_game', n2],
  ['Away: against / game', 'away_against_per_game', n2],
  ['1st half: for / game', 'first_half_for_per_game', n2],
  ['Match total / game', 'total_per_game', n2],
  [
    'Matches with data',
    'matches_with_data',
    (v) => (v === null || v === undefined ? NA : String(v)),
  ],
];

const MODEL_NAMES: Record<string, string> = {
  season: 'Season (time-weighted)',
  form: 'Form (last 6)',
  xg: 'xG',
};

export function ModelCard({
  model,
  title,
  homeName,
  awayName,
}: {
  model: StatModel;
  title: string;
  homeName: string;
  awayName: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {model.status !== 'OK' ? (
          <p className="text-muted-foreground">INSUFFICIENT DATA — {model.reason}</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="truncate text-xs text-muted-foreground">{homeName}</div>
                <div className="num text-2xl font-bold">{num(model.lambda_home)}</div>
              </div>
              <div>
                <div className="truncate text-xs text-muted-foreground">{awayName}</div>
                <div className="num text-2xl font-bold">{num(model.lambda_away)}</div>
              </div>
            </div>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Home</TableHead>
                  <TableHead className="text-right">Away</TableHead>
                  <TableHead className="text-right">Matches</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {model.models.map((m) => (
                  <TableRow key={m.name}>
                    <TableCell>{MODEL_NAMES[m.name] ?? m.name}</TableCell>
                    <TableCell className="num text-right">{num(m.lambda_home)}</TableCell>
                    <TableCell className="num text-right">{num(m.lambda_away)}</TableCell>
                    <TableCell className="num text-right">
                      {m.matches_home}/{m.matches_away}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
              <span>Data quality: {pct(model.data_quality, 0)}</span>
              <span>Relative std. error: {pct(model.relative_stderr, 0)}</span>
              <span>Form drift: {pct(model.form_drift, 0)}</span>
              <span>Min. matches: {model.min_matches}</span>
            </div>
            {model.adjustments.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-4 text-xs">
                {model.adjustments.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function TopScores({ a }: { a: MatchAnalysis }) {
  if (!a.top_scores.length) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Score distribution</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {a.top_scores.map((s) => (
            <div key={`${s.home}-${s.away}`} className="rounded-md border p-2 text-center">
              <div className="num text-sm font-bold">
                {s.home}:{s.away}
              </div>
              <div className="num text-xs text-muted-foreground">{pct(s.probability, 1)}</div>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Even the most likely exact score usually has well under 20% probability.
        </p>
      </CardContent>
    </Card>
  );
}

export function H2H({ a }: { a: MatchAnalysis }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Head-to-head</CardTitle>
      </CardHeader>
      <CardContent>
        {a.context.h2h.length === 0 ? (
          <p className="text-sm text-muted-foreground">No stored meetings.</p>
        ) : (
          <Table>
            <TableBody>
              {a.context.h2h.map((m) => (
                <TableRow key={m.fixture_id}>
                  <TableCell className="text-xs text-muted-foreground">
                    {shortDate(m.date)}
                  </TableCell>
                  <TableCell className="max-w-[180px] truncate">
                    {m.home} – {m.away}
                  </TableCell>
                  <TableCell className="num text-right font-semibold">{m.score}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <p className="mt-2 text-[11px] text-muted-foreground">
          Head-to-head is shown for context only and is not an input to the model: squads, coaches
          and strength change between meetings.
        </p>
      </CardContent>
    </Card>
  );
}
