import { Info } from 'lucide-react';
import Link from 'next/link';
import { getPlatformMeta } from '@/lib/server-api';
import { getT } from '@/i18n/server';

/** Always-visible notice: play money only. Compact, informative, never promotional. */
export async function DemoBanner() {
  const t = await getT();
  const { odds } = await getPlatformMeta();
  return (
    <div className="border-b border-border bg-surface/70" role="note" data-testid="demo-banner">
      <div className="mx-auto flex max-w-[1760px] items-center justify-center gap-2 px-4 py-1.5 text-[11px] leading-4 sm:text-xs lg:px-6">
        <span className="shrink-0 rounded-[5px] bg-warning-soft px-1.5 py-px font-bold uppercase tracking-wider text-warning">
          {t('Demo-Modus')}
        </span>
        <span className="min-w-0 truncate text-fg-muted">
          <span className="sm:hidden">{t('Nur Spielgeld · keine Ein- und Auszahlungen')}</span>
          <span className="hidden sm:inline">
            {t('Nur Spielgeld · Keine Einzahlungen · Keine Auszahlungen')}
          </span>
          <span className="hidden text-fg-subtle md:inline">
            {' · '}
            {odds.isSimulated
              ? t('Simulierte Spiele und Quoten')
              : t('Echte Spiele, Quoten: {0}', [odds.name])}
          </span>
        </span>
        <Link
          href="/responsible-gaming"
          className="grid size-5 shrink-0 place-items-center rounded-full text-fg-subtle transition-colors hover:text-fg"
          aria-label={t('Mehr zum Demo-Modus und verantwortungsvollen Spielen')}
        >
          <Info className="size-3.5" aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}
