'use client';

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '../lib/cn';

/*
 * The focus ring is a soft halo in the brand colour rather than a hard line
 * held off the button by an offset. The offset version needs the page colour
 * behind it to look right, which is exactly what a button in a toolbar, a
 * table row or a dialog footer does not have.
 */
const buttonVariants = cva(
  'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium ' +
    'transition-[background-color,background-image,border-color,color,box-shadow,transform] duration-150 ' +
    'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 ' +
    'disabled:pointer-events-none disabled:opacity-45 disabled:shadow-none ' +
    'active:translate-y-px [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        // `storm-key` lights the top edge and drops a shadow, so a filled
        // button reads as a key to press rather than a coloured rectangle.
        default: 'storm-key bg-primary text-primary-foreground hover:bg-primary/90',
        secondary:
          'storm-key-quiet border border-border bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80',
        outline:
          'storm-key-quiet border border-border bg-transparent shadow-xs hover:border-muted-foreground/30 hover:bg-secondary/60 hover:text-foreground',
        ghost: 'hover:bg-secondary/70 hover:text-foreground active:bg-secondary',
        destructive: 'storm-key bg-destructive text-destructive-foreground hover:bg-destructive/90',
        success: 'storm-key bg-success text-success-foreground hover:bg-success/90',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 rounded-md px-3 text-xs',
        default: 'h-9 px-4',
        lg: 'h-11 rounded-xl px-6 text-base',
        icon: 'h-9 w-9',
        'icon-sm': 'h-8 w-8 rounded-md',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, asChild = false, loading = false, children, disabled, ...props },
    ref,
  ) => {
    const Comp = asChild ? Slot : 'button';

    // `asChild` renders someone else's element, so a spinner would be a second
    // child and break Slot's single-child contract.
    if (asChild) {
      return (
        <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props}>
          {children}
        </Comp>
      );
    }

    return (
      <button
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={disabled || loading}
        {...props}
      >
        {loading ? <Loader2 className="animate-spin" aria-hidden /> : null}
        {children}
      </button>
    );
  },
);
Button.displayName = 'Button';

export { buttonVariants };
