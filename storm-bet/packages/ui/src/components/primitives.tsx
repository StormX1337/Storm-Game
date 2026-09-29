import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '../lib/cn';

export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'rounded-lg border border-border bg-surface shadow-[var(--shadow-card)]',
        className,
      )}
      {...props}
    />
  ),
);
Card.displayName = 'Card';

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex items-center justify-between gap-3 px-4 pt-4 pb-3', className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3 className={cn('text-sm font-semibold tracking-tight text-fg', className)} {...props} />
  );
}

export function CardDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-xs text-fg-muted', className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-4 pb-4', className)} {...props} />;
}

export const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide',
  {
    variants: {
      variant: {
        default: 'bg-surface-3 text-fg-muted',
        accent: 'bg-accent-soft text-accent-strong',
        live: 'bg-live-soft text-live',
        success: 'bg-up-soft text-up',
        danger: 'bg-down-soft text-down',
        warning: 'bg-warning-soft text-warning',
        outline: 'border border-border-strong text-fg-muted',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-md bg-surface-3/70', className)} {...props} />;
}

export function Separator({
  className,
  vertical = false,
}: {
  className?: string;
  vertical?: boolean;
}) {
  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      className={cn(vertical ? 'w-px self-stretch' : 'h-px w-full', 'bg-border', className)}
    />
  );
}

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }
>(({ className, invalid, ...props }, ref) => (
  <input
    ref={ref}
    aria-invalid={invalid || undefined}
    className={cn(
      'h-10 w-full rounded-md border border-border-strong bg-surface-2 px-3 text-sm text-fg placeholder:text-fg-subtle',
      'transition-colors focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30',
      'disabled:opacity-50 aria-[invalid]:border-down/70',
      className,
    )}
    {...props}
  />
));
Input.displayName = 'Input';

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }
>(({ className, invalid, ...props }, ref) => (
  <textarea
    ref={ref}
    aria-invalid={invalid || undefined}
    className={cn(
      'min-h-28 w-full rounded-md border border-border-strong bg-surface-2 px-3 py-2 text-sm text-fg placeholder:text-fg-subtle',
      'focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 aria-[invalid]:border-down/70',
      className,
    )}
    {...props}
  />
));
Textarea.displayName = 'Textarea';

export const NativeSelect = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }
>(({ className, invalid, children, ...props }, ref) => (
  <select
    ref={ref}
    aria-invalid={invalid || undefined}
    className={cn(
      'h-10 w-full appearance-none rounded-md border border-border-strong bg-surface-2 bg-[length:16px] bg-[right_10px_center] bg-no-repeat px-3 pr-9 text-sm text-fg',
      "bg-[url('data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%2024%2024%22%20fill=%22none%22%20stroke=%22%239aa3b2%22%20stroke-width=%222%22%3E%3Cpath%20d=%22m6%209%206%206%206-6%22/%3E%3C/svg%3E')]",
      'focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 aria-[invalid]:border-down/70',
      className,
    )}
    {...props}
  >
    {children}
  </select>
));
NativeSelect.displayName = 'NativeSelect';

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('text-xs font-medium text-fg-muted', className)} {...props} />;
}

export function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  error?: string | undefined;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? (
        <p role="alert" className="text-xs text-down">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-fg-subtle">{hint}</p>
      ) : null}
    </div>
  );
}

const CHECKBOX_CLASS = [
  'mt-0.5 size-4 shrink-0 cursor-pointer appearance-none rounded-[4px] border border-border-strong bg-surface-2',
  'checked:border-accent checked:bg-accent checked:bg-[length:12px] checked:bg-center checked:bg-no-repeat',
  "checked:bg-[url('data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%2024%2024%22%20fill=%22none%22%20stroke=%22%230a0d18%22%20stroke-width=%223.5%22%3E%3Cpath%20d=%22m5%2012%205%205L20%207%22/%3E%3C/svg%3E')]",
  'focus-visible:outline-2 focus-visible:outline-accent',
].join(' ');

export function Checkbox({
  className,
  label,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: React.ReactNode }) {
  return (
    <label
      className={cn('flex cursor-pointer items-start gap-2.5 text-sm text-fg-muted', className)}
    >
      <input type="checkbox" className={CHECKBOX_CLASS} {...props} />
      <span>{label}</span>
    </label>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-12 text-center',
        className,
      )}
    >
      {icon ? (
        <div className="grid size-11 place-items-center rounded-full bg-surface-3 text-fg-muted [&_svg]:size-5">
          {icon}
        </div>
      ) : null}
      <div className="space-y-1">
        <p className="text-sm font-medium text-fg">{title}</p>
        {description ? (
          <p className="mx-auto max-w-sm text-sm text-fg-muted">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  icon,
  tone = 'default',
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  tone?: 'default' | 'accent' | 'up' | 'down';
  className?: string;
}) {
  return (
    <Card className={cn('p-4', className)}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium text-fg-muted">{label}</p>
        {icon ? (
          <span
            className={cn(
              'grid size-8 place-items-center rounded-md [&_svg]:size-4',
              tone === 'accent' && 'bg-accent-soft text-accent-strong',
              tone === 'up' && 'bg-up-soft text-up',
              tone === 'down' && 'bg-down-soft text-down',
              tone === 'default' && 'bg-surface-3 text-fg-muted',
            )}
          >
            {icon}
          </span>
        ) : null}
      </div>
      <p className="tabular mt-2 text-2xl font-semibold tracking-tight text-fg">{value}</p>
      {hint ? <p className="mt-1 text-xs text-fg-subtle">{hint}</p> : null}
    </Card>
  );
}

export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn('w-full border-collapse text-sm', className)} {...props} />
    </div>
  );
}

export function Th({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        'whitespace-nowrap border-b border-border px-3 py-2.5 text-left text-xs font-medium text-fg-subtle',
        className,
      )}
      {...props}
    />
  );
}

export function Td({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      className={cn('border-b border-border/60 px-3 py-2.5 align-middle', className)}
      {...props}
    />
  );
}

export function Kbd({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        'rounded border border-border-strong bg-surface-2 px-1.5 text-[10px] text-fg-muted',
        className,
      )}
      {...props}
    />
  );
}
