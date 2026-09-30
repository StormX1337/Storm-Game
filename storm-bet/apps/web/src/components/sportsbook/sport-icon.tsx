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
    case 'hockey':
      return (
        <svg {...common}>
          <path d="M4 3l7 13h7" />
          <path d="M20 3l-7 13" />
          <ellipse cx="6.5" cy="19" rx="3" ry="1.5" />
        </svg>
      );
    case 'american_football':
      return (
        <svg {...common}>
          <ellipse cx="12" cy="12" rx="9.5" ry="6" transform="rotate(-35 12 12)" />
          <path d="M9.5 14.5l5-5M10.5 11l1 1M12.5 9l1 1M11.5 13l1 1" />
        </svg>
      );
    case 'baseball':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M6.3 5a10 10 0 0 1 0 14M17.7 5a10 10 0 0 0 0 14" />
        </svg>
      );
    case 'handball':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 3a15 15 0 0 1 0 18M3.5 9h17M3.5 15h17" />
        </svg>
      );
    case 'mma':
      return (
        <svg {...common}>
          <path d="M7 10V7a3 3 0 0 1 3-3h4a3 3 0 0 1 3 3v6a5 5 0 0 1-5 5h-1a4 4 0 0 1-4-4Z" />
          <path d="M7 10h6a2 2 0 0 1 0 4H9M8 18v3h8v-4" />
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
