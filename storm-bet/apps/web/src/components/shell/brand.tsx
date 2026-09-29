import Link from 'next/link';
import { cn } from '@storm-bet/ui';

export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-7', className)} aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--color-surface-3)" />
      <path d="M18.5 4.5 8.5 18h6.8l-2 9.5 10.2-14h-7l2-9Z" fill="var(--color-accent)" />
    </svg>
  );
}

export function Brand({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      className={cn('flex items-center gap-2 rounded-md', className)}
      aria-label="STORM BET Startseite"
    >
      <BrandMark />
      <span className="text-[15px] font-semibold tracking-[0.08em] text-fg">
        STORM<span className="text-accent"> BET</span>
      </span>
    </Link>
  );
}
