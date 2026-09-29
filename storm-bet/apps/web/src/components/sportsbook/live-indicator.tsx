import { cn } from '@storm-bet/ui';

export function LiveDot({ className }: { className?: string }) {
  return (
    <span
      className={cn('inline-block size-1.5 rounded-full bg-live animate-pulse-dot', className)}
      aria-hidden="true"
    />
  );
}

export function LiveBadge({ label = 'Live', className }: { label?: string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-sm bg-live-soft px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-live',
        className,
      )}
    >
      <LiveDot />
      {label}
    </span>
  );
}

export function DemoDataBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-sm border border-warning/30 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.02em] text-warning',
        className,
      )}
      title="Simulierte Daten – keine echten Spiele oder Quoten"
    >
      Demo
    </span>
  );
}
