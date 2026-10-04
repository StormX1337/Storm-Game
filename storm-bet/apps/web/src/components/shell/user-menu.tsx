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
  Plus,
  Receipt,
  Settings,
  Shield,
  ShieldCheck,
  Users,
  Wallet,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api-client';
import { formatMoney } from '@/lib/format';
import { useSession } from '../providers/session';
import { NotificationBell } from './notifications';
import { useT } from '@/i18n/client';
import { LanguageSwitch } from './language-switch';

export function UserMenu() {
  const t = useT();
  const { user, wallet } = useSession();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  if (!user) {
    return (
      <div className="flex items-center gap-1 sm:gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="px-2 max-md:text-white max-md:hover:bg-white/10 sm:px-3"
          asChild
        >
          <Link href="/login">{t('Anmelden')}</Link>
        </Button>
        <Button
          size="sm"
          className="px-2.5 max-md:bg-white max-md:text-[#2337c6] max-md:hover:bg-white/90 sm:px-3"
          asChild
        >
          <Link href="/register">{t('Registrieren')}</Link>
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
    <div className="flex items-center gap-1.5 sm:gap-2">
      <div className="flex items-stretch overflow-hidden rounded-md border border-white/25 bg-white/15 md:border-border md:bg-surface-2">
        <Link
          href="/dashboard/wallet"
          className="flex items-center gap-2 px-2 py-1.5 transition-colors hover:bg-white/10 sm:px-3 md:hover:bg-surface-3"
          aria-label={t('Guthaben (Spielgeld)')}
        >
          <Wallet className="hidden size-4 text-fg-muted sm:block" aria-hidden="true" />
          <span
            className="tabular text-sm font-semibold text-white md:text-fg"
            data-testid="header-balance"
          >
            {wallet ? formatMoney(wallet.available) : '—'}
          </span>
        </Link>
        <Link
          href="/dashboard/wallet"
          className="grid place-items-center bg-white px-2 text-[#2337c6] transition-colors hover:bg-white/90 md:bg-accent md:text-accent-fg md:hover:bg-accent/90"
          aria-label={t('Aufladen')}
          title={t('Aufladen')}
          data-testid="header-top-up"
        >
          <Plus className="size-4" aria-hidden="true" />
        </Link>
      </div>
      <NotificationBell />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="grid size-9 place-items-center rounded-full bg-white/20 text-xs font-semibold text-white transition-colors hover:bg-white/30 md:bg-accent-soft md:text-accent-strong md:hover:bg-accent/25"
            aria-label={t('Konto-Menü')}
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
              <LayoutDashboard /> {t('Übersicht')}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/dashboard/bets">
              <Receipt /> {t('Meine Wetten')}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/feed">
              <Users /> {t('Tipp-Feed')}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/dashboard/wallet">
              <Wallet /> {t('Guthaben')}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/dashboard/limits">
              <ShieldCheck /> {t('Limits')}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/dashboard/profile">
              <Settings /> {t('Profil & Sicherheit')}
            </Link>
          </DropdownMenuItem>
          {isStaff(user.role) ? (
            <DropdownMenuItem asChild>
              <Link href="/admin">
                <Shield /> {t('Admin-Bereich')}
              </Link>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <div className="flex items-center justify-between px-2 py-1.5 text-xs text-fg-muted">
            {t('Sprache')}
            <LanguageSwitch />
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void logout()} disabled={busy} data-testid="logout">
            <LogOut /> {t('Abmelden')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
