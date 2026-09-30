'use client';

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  toast,
} from '@storm-bet/ui';
import { isStaff } from '@storm-bet/types';
import {
  LayoutDashboard,
  LogOut,
  Receipt,
  Settings,
  Shield,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api-client';
import { formatMoney } from '@/lib/format';
import { useSession } from '../providers/session';
import { NotificationBell } from './notifications';

export function UserMenu() {
  const { user, wallet } = useSession();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  if (!user) {
    return (
      <div className="flex items-center gap-1 sm:gap-2">
        <Button variant="ghost" size="sm" className="px-2 sm:px-3" asChild>
          <Link href="/login">Anmelden</Link>
        </Button>
        <Button size="sm" className="px-2.5 sm:px-3" asChild>
          <Link href="/register">Registrieren</Link>
        </Button>
      </div>
    );
  }

  const logout = async () => {
    setBusy(true);
    try {
      await api('/auth/logout', { method: 'POST' });
      router.push('/');
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const initials = user.displayName
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="flex items-center gap-2">
      <Link
        href="/dashboard/wallet"
        className="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-2 py-1.5 transition-colors hover:border-border-strong sm:px-3"
        aria-label="Guthaben (Spielgeld)"
      >
        <Wallet className="hidden size-4 text-fg-muted sm:block" aria-hidden="true" />
        <span className="tabular text-sm font-semibold text-fg" data-testid="header-balance">
          {wallet ? formatMoney(wallet.available) : '—'}
        </span>
      </Link>
      <NotificationBell />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="grid size-9 place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent-strong transition-colors hover:bg-accent/25"
            aria-label="Konto-Menü"
            data-testid="user-menu"
          >
            {initials}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>
            <span className="block truncate text-sm font-medium text-fg">{user.displayName}</span>
            <span className="block truncate">{user.email}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href="/dashboard">
              <LayoutDashboard /> Übersicht
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/dashboard/bets">
              <Receipt /> Meine Wetten
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/dashboard/wallet">
              <Wallet /> Guthaben
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/dashboard/limits">
              <ShieldCheck /> Limits
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/dashboard/profile">
              <Settings /> Profil & Sicherheit
            </Link>
          </DropdownMenuItem>
          {isStaff(user.role) ? (
            <DropdownMenuItem asChild>
              <Link href="/admin">
                <Shield /> Admin-Bereich
              </Link>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void logout()} disabled={busy} data-testid="logout">
            <LogOut /> Abmelden
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
