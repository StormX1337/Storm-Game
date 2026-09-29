'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import useSWR from 'swr';
import {
  CalendarDays,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Radar,
  Settings2,
  Sun,
  Wallet,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { post } from '@/lib/api';
import type { User } from '@/lib/types';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/scanner', label: 'Scanner', icon: Radar },
  { href: '/matches', label: 'Matches', icon: CalendarDays },
  { href: '/history', label: 'History', icon: History },
  { href: '/bankroll', label: 'Bankroll', icon: Wallet },
];

function NavLinks({ admin, onNavigate }: { admin: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  const items = admin ? [...NAV, { href: '/admin', label: 'Admin', icon: Settings2 }] : NAV;
  return (
    <nav className="flex flex-col gap-1">
      {items.map(({ href, label, icon: Icon }) => {
        const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            className={cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
              active
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2 px-1">
      <div className="grid h-8 w-8 place-items-center rounded-md bg-primary text-primary-foreground">
        <Radar className="h-4 w-4" />
      </div>
      <div className="leading-tight">
        <div className="text-sm font-bold tracking-tight">FOOTBALL VALUE</div>
        <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          Scanner
        </div>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { data: user } = useSWR<User>('/api/auth/me');
  const { resolvedTheme, setTheme } = useTheme();
  const router = useRouter();
  const admin = user?.role === 'admin';
  // The theme is only known in the browser; rendering the icon before mount
  // would make the server and client HTML disagree.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  async function logout() {
    await post('/api/auth/logout').catch(() => undefined);
    router.push('/login');
  }

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col gap-6 border-r bg-card/50 p-4 lg:flex">
        <Brand />
        <NavLinks admin={admin} />
        <div className="mt-auto space-y-2 text-[11px] leading-snug text-muted-foreground">
          <p>
            Signals are statistical estimates, not predictions of fixed results. No outcome is
            guaranteed.
          </p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/90 px-4 backdrop-blur">
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open menu">
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent>
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <div className="flex flex-col gap-6">
                <Brand />
                <NavLinks admin={admin} />
              </div>
            </SheetContent>
          </Sheet>
          <div className="lg:hidden">
            <Brand />
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden text-xs text-muted-foreground sm:inline">{user?.email}</span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Toggle theme"
              onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
            >
              {mounted ? (
                resolvedTheme === 'dark' ? (
                  <Sun />
                ) : (
                  <Moon />
                )
              ) : (
                <Sun className="opacity-0" />
              )}
            </Button>
            <Button variant="ghost" size="icon" aria-label="Sign out" onClick={logout}>
              <LogOut />
            </Button>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1500px] flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
