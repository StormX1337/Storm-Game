'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Bell, ShieldCheck, User } from 'lucide-react';
import { cn } from '@storm/ui';

const TABS = [
  { href: '/account', label: 'Profile', icon: User, exact: true },
  { href: '/account/security', label: 'Security', icon: ShieldCheck },
  { href: '/account/notifications', label: 'Notifications', icon: Bell },
];

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
        <p className="text-sm text-muted-foreground">
          Manage your profile, security settings and notifications.
        </p>
      </div>

      <nav className="flex gap-1 border-b border-border" aria-label="Account sections">
        {TABS.map((tab) => {
          const active = tab.exact ? pathname === tab.href : pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={cn(
                'relative flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium transition-colors',
                active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
              aria-current={active ? 'page' : undefined}
            >
              <tab.icon className="h-3.5 w-3.5" />
              {tab.label}
              {active ? (
                <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary" />
              ) : null}
            </Link>
          );
        })}
      </nav>

      <div className="animate-fade-in">{children}</div>
    </div>
  );
}
