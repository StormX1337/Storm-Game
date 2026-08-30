'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import type { Permission, UserDetail } from '@storm/types';
import { api, ApiError } from './api';

interface AuthState {
  user: UserDetail | null;
  permissions: Set<string>;
  loading: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  /** Panel-wide permission check. Server-scoped checks come from the server payload. */
  can: (...permissions: (Permission | string)[]) => boolean;
  isAdmin: boolean;
}

const AuthContext = React.createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const context = React.useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}

interface MeResponse {
  user: UserDetail;
  permissions: string[];
}

export function AuthProvider({
  children,
  initialUser = null,
}: {
  children: React.ReactNode;
  initialUser?: UserDetail | null;
}): React.JSX.Element {
  const router = useRouter();
  const [user, setUser] = React.useState<UserDetail | null>(initialUser);
  const [permissions, setPermissions] = React.useState<Set<string>>(
    () => new Set(initialUser?.permissions ?? []),
  );
  const [loading, setLoading] = React.useState(true);

  const refresh = React.useCallback(async () => {
    try {
      const response = await api.get<MeResponse>('/auth/me');
      setUser(response.user);
      setPermissions(new Set(response.permissions));
    } catch (error) {
      // A 401 here is the normal "not signed in" case, not a failure.
      if (!(error instanceof ApiError) || error.isAuthError) {
        setUser(null);
        setPermissions(new Set());
      }
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOut = React.useCallback(async () => {
    await api.post('/auth/logout', {}).catch(() => undefined);
    setUser(null);
    setPermissions(new Set());
    router.push('/login');
  }, [router]);

  const value = React.useMemo<AuthState>(
    () => ({
      user,
      permissions,
      loading,
      refresh,
      signOut,
      can: (...required) =>
        user?.role === 'OWNER' || required.some((permission) => permissions.has(permission)),
      isAdmin:
        user?.role === 'OWNER' ||
        permissions.has('admin.dashboard') ||
        permissions.has('admin.servers'),
    }),
    [user, permissions, loading, refresh, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Redirects to the sign-in page once we know the visitor is not signed in. */
export function useRequireAuth(): { user: UserDetail | null; loading: boolean } {
  const { user, loading } = useAuth();
  const router = useRouter();

  React.useEffect(() => {
    if (!loading && !user) {
      const next = window.location.pathname + window.location.search;
      router.replace(`/login?next=${encodeURIComponent(next)}`);
    }
  }, [loading, user, router]);

  return { user, loading };
}
