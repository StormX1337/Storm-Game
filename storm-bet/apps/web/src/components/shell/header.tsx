'use client';

import { cn } from '@storm-bet/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LiveDot } from '../sportsbook/live-indicator';
import { Brand } from './brand';
import { UserMenu } from './user-menu';

const NAV = [
  { href: '/sports', label: 'Sport' },
  { href: '/live', label: 'Live', live: true },
];

export function Header({ liveCount }: { liveCount?: number }) {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg/85 backdrop-blur supports-[backdrop-filter]:bg-bg/70">
      <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-4 px-4 lg:px-6">
        <Brand />
        <nav aria-label="Hauptnavigation" className="flex items-center gap-1">
          {NAV.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors',
                  active ? 'bg-surface-3 text-fg' : 'text-fg-muted hover:text-fg',
                )}
              >
                {item.live ? <LiveDot /> : null}
                {item.label}
                {item.live && liveCount ? (
                  <span className="tabular text-xs text-fg-subtle">{liveCount}</span>
                ) : null}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto">
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
