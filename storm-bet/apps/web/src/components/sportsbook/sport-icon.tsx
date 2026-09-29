import type { SportKey } from '@storm-bet/types';
import { cn } from '@storm-bet/ui';

/** Line icons in the lucide style (stroke 2, 24px grid). */
export function SportIcon({ sport, className }: { sport: SportKey | string; className?: string }) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className: cn('size-4 shrink-0', className),
    'aria-hidden': true,
  };
  switch (sport) {
    case 'football':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="m12 7.5 3.4 2.5-1.3 4h-4.2l-1.3-4Z" />
          <path d="M12 3v4.5M20.3 9.3 15.4 10M17 19.5l-2.9-5.5M7 19.5l2.9-5.5M3.7 9.3l4.9.7" />
        </svg>
      );
    case 'tennis':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M5.6 5.6c3.5 3.5 3.5 9.3 0 12.8M18.4 5.6c-3.5 3.5-3.5 9.3 0 12.8" />
        </svg>
      );
    case 'basketball':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3v18" />
          <path d="M5.6 5.6c2.4 2.4 2.4 10.4 0 12.8M18.4 5.6c-2.4 2.4-2.4 10.4 0 12.8" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
        </svg>
      );
  }
}
