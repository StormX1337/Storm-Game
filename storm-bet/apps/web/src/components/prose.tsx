'use client';

import { cn } from '@storm-bet/ui';
import { useT } from '@/i18n/client';

/** Long-form text (legal pages, help). Styled here instead of a typography plugin. */
export function Prose({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <article
      className={cn(
        'space-y-4 text-[15px] leading-relaxed text-fg-muted',
        '[&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:tracking-tight [&_h1]:text-fg sm:[&_h1]:text-3xl',
        '[&_h2]:pt-4 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-fg',
        '[&_strong]:text-fg [&_a]:text-accent-strong [&_a]:underline-offset-2 hover:[&_a]:underline',
        '[&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5 [&_li]:marker:text-fg-subtle',
        className,
      )}
    >
      {children}
    </article>
  );
}

export function Updated({ date }: { date: string }) {
  const t = useT();
  return (
    <p className="text-xs text-fg-subtle">
      {t('Stand:')} {date}
    </p>
  );
}
