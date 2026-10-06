'use client';

import Link from 'next/link';
import { cn } from '@storm-bet/ui';
import { useT } from '@/i18n/client';
import { useSession } from '../providers/session';

/** The STORM mark: a lightning bolt on the brand gradient. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-7', className)} aria-hidden="true">
      <defs>
        <linearGradient id="storm-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4f5bff" />
          <stop offset="1" stopColor="#8b5cf6" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#storm-mark)" />
      <path d="M18.5 4.5 8.5 18h6.8l-2 9.5 10.2-14h-7l2-9Z" fill="#fff" />
    </svg>
  );
}

export function Brand({
  className,
  alwaysShowName = false,
}: {
  className?: string;
  alwaysShowName?: boolean;
}) {
  const t = useT();
  const { user } = useSession();
  return (
    <Link
      href="/"
      className={cn('flex shrink-0 items-center gap-2 rounded-md', className)}
      aria-label={t('STORM BET Startseite')}
    >
      <BrandMark className={alwaysShowName ? undefined : 'lg:size-8'} />
      <span
        className={cn(
          'text-[15px] font-extrabold tracking-[0.12em] text-fg',
          !alwaysShowName && 'max-md:text-[14px] max-md:tracking-[0.06em] lg:text-[18px]',
        )}
      >
        STORM
        <span
          className={cn(
            'font-semibold text-accent-strong',
            // Narrow phones keep the room for balance (logged in) or the two buttons.
            !alwaysShowName && (user ? 'max-[429px]:hidden' : 'max-[389px]:hidden'),
          )}
        >
          {' '}
          BET
        </span>
      </span>
    </Link>
  );
}
