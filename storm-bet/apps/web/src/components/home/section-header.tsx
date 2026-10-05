import { ChevronRight } from 'lucide-react';
import Link from 'next/link';

/** Section title with an optional count and "see all" link – one style for the whole page. */
export function SectionHeader({
  id,
  title,
  icon,
  count,
  href,
  linkLabel,
}: {
  id?: string;
  title: React.ReactNode;
  icon?: React.ReactNode;
  count?: number;
  href?: string;
  linkLabel?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 id={id} className="flex items-center gap-2 text-[17px] font-bold tracking-tight">
        {icon}
        {title}
        {count ? (
          <span className="tabular rounded-full bg-surface-3 px-2 py-0.5 text-[11px] font-semibold text-fg-muted">
            {count}
          </span>
        ) : null}
      </h2>
      {href && linkLabel ? (
        <Link
          href={href}
          className="flex shrink-0 items-center gap-0.5 text-[13px] font-semibold text-accent-strong transition-colors hover:text-fg"
        >
          {linkLabel}
          <ChevronRight className="size-4" aria-hidden="true" />
        </Link>
      ) : null}
    </div>
  );
}
