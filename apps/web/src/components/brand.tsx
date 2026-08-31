'use client';

import { cn } from '@storm/ui';
import { usePanelSettings } from '@/lib/panel-settings';

/**
 * Storm mark: a bolt cut from a rounded square. Drawn as inline SVG so it
 * inherits `currentColor` and stays crisp at every size, with no image request
 * on first paint.
 */
export function StormMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      className={cn('h-8 w-8', className)}
      aria-hidden="true"
      role="presentation"
    >
      <rect width="32" height="32" rx="9" className="fill-primary" />
      <path
        d="M18.4 5.5 10 17.2h4.7L13.2 26.5 22 14.4h-4.9l1.3-8.9Z"
        className="fill-primary-foreground"
      />
    </svg>
  );
}

export function StormLogo({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  // The name is whatever the administrator set in the panel settings; it is
  // theirs to rebrand, and the mark takes its colour from the same place.
  const { panelName } = usePanelSettings();

  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <StormMark className={compact ? 'h-7 w-7' : 'h-8 w-8'} />
      {compact ? null : (
        <span className="flex min-w-0 flex-col leading-none">
          <span className="truncate text-[15px] font-semibold tracking-tight">{panelName}</span>
          <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Game hosting
          </span>
        </span>
      )}
    </span>
  );
}

/** The panel's own name as plain text, for copy inside server components. */
export function PanelName() {
  const { panelName } = usePanelSettings();
  return <>{panelName}</>;
}
