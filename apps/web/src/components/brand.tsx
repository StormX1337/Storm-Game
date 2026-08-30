import { cn } from '@storm/ui';

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
  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <StormMark className={compact ? 'h-7 w-7' : 'h-8 w-8'} />
      {compact ? null : (
        <span className="flex flex-col leading-none">
          <span className="text-[15px] font-semibold tracking-tight">Storm Panel</span>
          <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Game hosting
          </span>
        </span>
      )}
    </span>
  );
}
