'use client';

import { cn } from '@storm-bet/ui';
import { useRouter } from 'next/navigation';
import { useLocale } from '@/i18n/client';
import { LOCALE_COOKIE, type Locale } from '@/i18n/locale';

/** DE | EN: remembered in a cookie for a year; the page re-renders in place. */
export function LanguageSwitch({ className }: { className?: string }) {
  const locale = useLocale();
  const router = useRouter();
  const set = (next: Locale) => {
    if (next === locale) return;
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  };
  return (
    <div
      className={cn('inline-flex rounded-md border border-border p-0.5 text-xs', className)}
      role="radiogroup"
      aria-label="Sprache / Language"
    >
      {(['de', 'en'] as const).map((l) => (
        <button
          key={l}
          type="button"
          role="radio"
          aria-checked={locale === l}
          onClick={() => set(l)}
          className={cn(
            'rounded px-2 py-0.5 font-semibold uppercase transition-colors',
            locale === l ? 'bg-surface-3 text-fg' : 'text-fg-muted hover:text-fg',
          )}
          data-testid={`lang-${l}`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
