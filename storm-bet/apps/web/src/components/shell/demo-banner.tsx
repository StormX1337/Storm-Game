import { ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { getPlatformMeta } from '@/lib/server-api';
import { getT } from '@/i18n/server';

export async function DemoBanner() {
  const t = await getT();
  const { odds } = await getPlatformMeta();
  return (
    <div className="border-b border-warning/15 bg-warning-soft/60">
      <div className="mx-auto flex max-w-[1600px] items-center justify-center gap-2 px-4 py-1.5 text-center text-xs text-warning">
        <ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" />
        <span>
          <strong className="font-semibold">{t('Demo-Modus:')}</strong>{' '}
          {t('ausschließlich Spielgeld')}
          {odds.isSimulated
            ? t(', simulierte Spiele und Quoten')
            : t(' auf echte Spiele (Quoten: {0})', [odds.name])}
          {t('. Keine Einzahlungen, keine Auszahlungen.')}{' '}
          <Link href="/responsible-gaming" className="underline underline-offset-2 hover:text-fg">
            <span className="hidden sm:inline">{t('Verantwortungsvolles Spielen')}</span>
            <span className="sm:hidden">{t('Mehr')}</span>
          </Link>
        </span>
      </div>
    </div>
  );
}
