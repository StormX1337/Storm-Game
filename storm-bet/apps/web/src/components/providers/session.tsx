'use client';

import type { SessionUserDto, WalletDto } from '@storm-bet/types';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api-client';

interface SessionContextValue {
  user: SessionUserDto | null;
  wallet: WalletDto | null;
  refreshWallet: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue>({
  user: null,
  wallet: null,
  refreshWallet: async () => undefined,
});

export const WALLET_CHANGED = 'storm-bet:wallet-changed';

/** Tells every wallet display to reload (after a bet, a top-up, a settlement). */
export function announceWalletChange(wallet?: WalletDto) {
  window.dispatchEvent(new CustomEvent<WalletDto | undefined>(WALLET_CHANGED, { detail: wallet }));
}

export function SessionProvider({
  user,
  children,
}: {
  user: SessionUserDto | null;
  children: React.ReactNode;
}) {
  const [wallet, setWallet] = useState<WalletDto | null>(null);

  const refreshWallet = useCallback(async () => {
    if (!user) return;
    try {
      setWallet(await api<WalletDto>('/wallet'));
    } catch {
      // The header simply keeps the last known value.
    }
  }, [user]);

  useEffect(() => {
    if (!user) {
      setWallet(null);
      return;
    }
    void refreshWallet();
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<WalletDto | undefined>).detail;
      if (detail) setWallet(detail);
      else void refreshWallet();
    };
    window.addEventListener(WALLET_CHANGED, onChange);
    const timer = window.setInterval(() => void refreshWallet(), 30_000);
    return () => {
      window.removeEventListener(WALLET_CHANGED, onChange);
      window.clearInterval(timer);
    };
  }, [user, refreshWallet]);

  const value = useMemo(() => ({ user, wallet, refreshWallet }), [user, wallet, refreshWallet]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  return useContext(SessionContext);
}
