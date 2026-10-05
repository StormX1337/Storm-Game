import { cn } from '@storm-bet/ui';
import Link from 'next/link';

export interface FilterChip {
  key: string;
  href: string;
  label: React.ReactNode;
  active: boolean;
  count?: number;
  testId?: string;
}

/** One row of link chips (sports, days, competitions) that scrolls sideways on phones. */
export function FilterChips({ items, label }: { items: FilterChip[]; label: string }) {
  return (
    <nav
      aria-label={label}
      className="scrollbar-none -mx-4 flex gap-2 overflow-x-auto overscroll-x-contain px-4 md:mx-0 md:flex-wrap md:px-0"
    >
      {items.map((item) => (
        <Link
          key={item.key}
          href={item.href}
          aria-current={item.active ? 'page' : undefined}
          className={cn(
            'flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold transition-colors',
            item.active
              ? 'border-accent/50 bg-accent-soft text-fg [&_svg]:text-accent-strong'
              : 'border-border bg-surface text-fg-muted hover:border-border-strong hover:text-fg',
          )}
          data-testid={item.testId}
        >
          {item.label}
          {item.count !== undefined ? (
            <span className="tabular text-[11px] font-medium text-fg-subtle">{item.count}</span>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}

/** Two or three views of one page as a segmented control (links, so they stay shareable). */
export function ViewTabs({
  items,
  label,
}: {
  items: { key: string; href: string; label: React.ReactNode; active: boolean }[];
  label: string;
}) {
  return (
    <nav
      aria-label={label}
      className="flex w-full rounded-xl border border-border bg-surface p-1 sm:w-fit"
    >
      {items.map((item) => (
        <Link
          key={item.key}
          href={item.href}
          aria-current={item.active ? 'page' : undefined}
          className={cn(
            'flex h-9 flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-4 text-sm font-semibold transition-colors sm:flex-none',
            item.active ? 'bg-surface-3 text-fg' : 'text-fg-muted hover:text-fg',
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
