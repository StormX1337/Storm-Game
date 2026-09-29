import { ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { getPlatformMeta } from '@/lib/server-api';

export async function DemoBanner() {
  const { odds } = await getPlatformMeta();
  return (
    <div className="border-b border-warning/15 bg-warning-soft/60">
      <div className="mx-auto flex max-w-[1600px] items-center justify-center gap-2 px-4 py-1.5 text-center text-xs text-warning">
        <ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" />
        <span>
          <strong className="font-semibold">Demo-Modus:</strong> ausschließlich Spielgeld
          {odds.isSimulated
            ? ', simulierte Spiele und Quoten'
            : ` auf echte Spiele (Quoten: ${odds.name})`}
          . Keine Einzahlungen, keine Auszahlungen.{' '}
          <Link href="/responsible-gaming" className="underline underline-offset-2 hover:text-fg">
            <span className="hidden sm:inline">Verantwortungsvolles Spielen</span>
            <span className="sm:hidden">Mehr</span>
          </Link>
        </span>
      </div>
    </div>
  );
}
