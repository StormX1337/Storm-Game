import type { EventSummaryDto, Paginated, SportDto } from '@storm-bet/types';
import { Button, Card } from '@storm-bet/ui';
import {
  ArrowRight,
  Gauge,
  HeartHandshake,
  LineChart,
  Lock,
  ShieldCheck,
  Sparkles,
  Zap,
} from 'lucide-react';
import Link from 'next/link';
import { BoostList } from '@/components/sportsbook/boost-list';
import { EventList } from '@/components/sportsbook/event-list';
import { LiveDot } from '@/components/sportsbook/live-indicator';
import { SectionTitle } from '@/components/sportsbook/page-header';
import { SportIcon } from '@/components/sportsbook/sport-icon';
import { getPlatformMeta, getSessionUser, tryServerApi } from '@/lib/server-api';
import { getT } from '@/i18n/server';

export const dynamic = 'force-dynamic';

const FEATURES = [
  {
    icon: Zap,
    title: 'Live-Quoten in Echtzeit',
    text: 'Spielstände, Marktstatus und Quoten aktualisieren sich ohne Neuladen. Jede Änderung ist sichtbar markiert.',
  },
  {
    icon: ShieldCheck,
    title: 'Serverseitig geprüft',
    text: 'Jede Wette wird beim Platzieren gegen den aktuellen Stand geprüft. Eine geänderte Quote nimmst du selbst an – nie automatisch zu deinem Nachteil.',
  },
  {
    icon: LineChart,
    title: 'Transparente Abrechnung',
    text: 'Einsätze werden reserviert, Ergebnisse automatisch abgerechnet, jede Buchung ist im Verlauf nachvollziehbar.',
  },
  {
    icon: Gauge,
    title: 'Limits & Kontrolle',
    text: 'Lege Einsatzlimits pro Tag, Woche oder Monat fest oder pausiere dein Konto mit einer Selbstsperre.',
  },
];

export default async function HomePage() {
  const t = await getT();
  const { odds } = await getPlatformMeta();
  // Real fixtures are days apart; the simulator fills every hour.
  const within = odds.isSimulated ? 24 : 72;
  const [user, sports, live, upcoming] = await Promise.all([
    getSessionUser(),
    tryServerApi<SportDto[]>('/sports'),
    tryServerApi<Paginated<EventSummaryDto>>('/events?status=live&limit=6'),
    tryServerApi<Paginated<EventSummaryDto>>(
      `/events?status=upcoming&withinHours=${within}&limit=8`,
    ),
  ]);

  return (
    <div className="space-y-10">
      <section className="relative overflow-hidden rounded-xl border border-border bg-surface px-5 py-6 sm:px-10 sm:py-12">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-24 -top-24 size-80 rounded-full bg-accent/15 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,rgb(255_255_255/0.025)_1px,transparent_1px),linear-gradient(to_bottom,rgb(255_255_255/0.025)_1px,transparent_1px)] bg-[size:48px_48px] [mask-image:radial-gradient(ellipse_at_top_right,black,transparent_70%)]"
        />
        <div className="relative max-w-2xl space-y-4">
          <span className="inline-flex items-center gap-2 rounded-full border border-border-strong bg-surface-2 px-3 py-1 text-xs text-fg-muted">
            <Sparkles className="size-3.5 text-accent" aria-hidden="true" />{' '}
            {t('Demo-Plattform · kein Echtgeld')}
          </span>
          <h1 className="text-2xl font-semibold leading-tight tracking-tight sm:text-5xl">
            {t('Sportwetten,')} <span className="text-accent-strong">{t('präzise')}</span> gebaut.
          </h1>
          <p className="max-w-xl text-sm leading-relaxed text-fg-muted sm:text-base">
            {t(
              'Live-Quoten, Bet Builder, Cashout und nachvollziehbare Abrechnung – vollständig mit Demo-Guthaben',
            )}
            {odds.isSimulated
              ? t(' und simulierten Spielen')
              : t(' auf echte Spiele (Quoten: {0})', [odds.name])}
            .
          </p>
          <div className="flex flex-wrap gap-3">
            {user ? (
              <Button size="lg" asChild>
                <Link href="/live">
                  {t('Zu den Live-Events')} <ArrowRight />
                </Link>
              </Button>
            ) : (
              <Button size="lg" asChild>
                <Link href="/register">
                  {t('Kostenlos testen')} <ArrowRight />
                </Link>
              </Button>
            )}
            <Button size="lg" variant="outline" asChild>
              <Link href="/sports">{t('Alle Sportarten')}</Link>
            </Button>
          </div>
        </div>
      </section>

      <BoostList />

      <section className="space-y-3" aria-labelledby="live-title">
        <SectionTitle
          action={
            <Link href="/live" className="text-sm text-accent hover:underline">
              {t('Alle Live-Events')}
            </Link>
          }
        >
          <LiveDot /> <span id="live-title">{t('Jetzt live')}</span>
        </SectionTitle>
        <EventList
          events={live?.items ?? []}
          subscribeLive
          emptyTitle={t('Gerade läuft kein Event')}
          emptyDescription={t('Schau gleich wieder vorbei – neue Spiele beginnen laufend.')}
        />
      </section>

      <section className="space-y-3" aria-labelledby="sports-title">
        <SectionTitle>
          <span id="sports-title">{t('Sportarten')}</span>
        </SectionTitle>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4">
          {(sports ?? []).map((sport) => (
            <Link
              key={sport.key}
              href={`/sports/${sport.key}`}
              className="group flex items-center gap-4 rounded-lg border border-border bg-surface p-4 transition-colors hover:border-border-strong hover:bg-surface-2"
            >
              <span className="grid size-11 place-items-center rounded-lg bg-surface-3 text-fg-muted transition-colors group-hover:text-accent-strong">
                <SportIcon sport={sport.key} className="size-5" />
              </span>
              <div className="min-w-0">
                <p className="font-semibold">{t(sport.name)}</p>
                <p className="text-xs text-fg-muted">
                  {sport.eventCount} {t('Events')}
                  {sport.liveCount ? (
                    <span className="ml-2 inline-flex items-center gap-1 text-live">
                      <LiveDot /> {sport.liveCount} live
                    </span>
                  ) : null}
                </p>
              </div>
              <ArrowRight
                className="ml-auto size-4 text-fg-subtle transition-transform group-hover:translate-x-0.5"
                aria-hidden="true"
              />
            </Link>
          ))}
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="upcoming-title">
        <SectionTitle
          action={
            <Link href="/sports" className="text-sm text-accent hover:underline">
              {t('Mehr anzeigen')}
            </Link>
          }
        >
          <span id="upcoming-title">{t('Demnächst')}</span>
        </SectionTitle>
        <EventList events={upcoming?.items ?? []} emptyTitle={t('Keine anstehenden Events')} />
      </section>

      <section
        className="grid gap-4 lg:grid-cols-[1.1fr_1fr]"
        aria-label={t('Demo-Bonus und Hinweise')}
      >
        <Card className="relative overflow-hidden p-6">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -bottom-16 -right-10 size-56 rounded-full bg-up/10 blur-3xl"
          />
          <p className="text-xs font-semibold uppercase tracking-wider text-up">
            {t('Demo-Bonus')}
          </p>
          <p className="mt-2 text-3xl font-semibold tracking-tight">{t('1.000 € Startguthaben')}</p>
          <p className="mt-2 max-w-md text-sm text-fg-muted">
            {t(
              'Jedes neue Konto startet mit 1.000 € Spielgeld. Es hat keinen Geldwert, kann nicht ausgezahlt werden und dient nur zum Ausprobieren. Ist es fast aufgebraucht, kannst du es einmal täglich aufladen.',
            )}
          </p>
          {!user ? (
            <Button className="mt-5" asChild>
              <Link href="/register">{t('Konto erstellen')}</Link>
            </Button>
          ) : null}
        </Card>
        <Card className="p-6">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-warning-soft text-warning">
              <HeartHandshake className="size-5" aria-hidden="true" />
            </span>
            <div className="space-y-2">
              <p className="font-semibold">{t('Verantwortungsvoll spielen')}</p>
              <p className="text-sm text-fg-muted">
                {t(
                  'Wetten sollen unterhalten, nicht belasten. Nutze Einsatzlimits und die Selbstsperre in deinem Konto. Teilnahme ab 18 Jahren. Hilfe bei Glücksspielproblemen: BZgA-Hotline 0800 1 37 27 00.',
                )}
              </p>
              <Link
                href="/responsible-gaming"
                className="inline-flex items-center gap-1 text-sm text-accent hover:underline"
              >
                {t('Mehr erfahren')} <ArrowRight className="size-3.5" aria-hidden="true" />
              </Link>
            </div>
          </div>
        </Card>
      </section>

      <section className="space-y-3" aria-labelledby="features-title">
        <SectionTitle>
          <span id="features-title">{t('Warum STORM BET')}</span>
        </SectionTitle>
        <div className="grid gap-3 sm:grid-cols-2">
          {FEATURES.map((f) => (
            <Card key={f.title} className="p-5">
              <f.icon className="size-5 text-accent" aria-hidden="true" />
              <p className="mt-3 font-semibold">{t(f.title)}</p>
              <p className="mt-1 text-sm leading-relaxed text-fg-muted">{t(f.text)}</p>
            </Card>
          ))}
        </div>
        <p className="flex items-center gap-2 text-xs text-fg-subtle">
          <Lock className="size-3.5" aria-hidden="true" />{' '}
          {t('Keine Einzahlungen, keine Auszahlungen, keine Gewinnversprechen.')}
        </p>
      </section>
    </div>
  );
}
