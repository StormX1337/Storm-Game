import Link from 'next/link';
import { Brand } from '@/components/shell/brand';
import { DemoBanner } from '@/components/shell/demo-banner';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <DemoBanner />
      <div className="relative flex flex-1 items-center justify-center overflow-hidden px-4 py-12">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-0 size-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/10 blur-3xl"
        />
        <div className="relative w-full max-w-sm space-y-6">
          <div className="flex justify-center">
            <Brand alwaysShowName />
          </div>
          {children}
          <p className="text-center text-xs text-fg-subtle">
            Nur Demo-Guthaben · ab 18 Jahren ·{' '}
            <Link href="/responsible-gaming" className="underline underline-offset-2 hover:text-fg">
              Verantwortungsvolles Spielen
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
