'use client';

import type { AdminUserDetailDto, UserRole } from '@storm-bet/types';
import { hasPermission, LIMIT_TYPES, Permission, USER_ROLES } from '@storm-bet/types';
import { Field, Input, NativeSelect } from '@storm-bet/ui';
import { useState } from 'react';
import { parseStake } from '@/lib/format';
import { LIMIT_LABELS, ROLE_LABELS } from '@/lib/labels';
import { useSession } from '../providers/session';
import { ReasonAction } from './reason-action';

export function UserActions({ user }: { user: AdminUserDetailDto }) {
  const { user: me } = useSession();
  const [role, setRole] = useState<UserRole>(user.role);
  const [password, setPassword] = useState('');
  const [limitType, setLimitType] = useState<(typeof LIMIT_TYPES)[number]>('STAKE_DAILY');
  const [limitValue, setLimitValue] = useState('');
  if (!me) return null;
  const canManage = hasPermission(me.role, Permission.USERS_MANAGE);
  const canRoles = hasPermission(me.role, Permission.USERS_ROLES);
  const self = me.id === user.id;
  const parsedLimit = limitValue.trim() === '' ? null : parseStake(limitValue);

  return (
    <div className="flex flex-wrap gap-2">
      {canManage && !self ? (
        user.status === 'LOCKED' ? (
          <ReasonAction
            label="Entsperren"
            title="Konto entsperren"
            path={`/admin/users/${user.id}/unlock`}
            successMessage="Konto entsperrt"
          />
        ) : (
          <ReasonAction
            label="Sperren"
            title="Konto sperren"
            description="Alle Sitzungen werden sofort beendet. Offene Wetten bleiben bestehen und werden regulär abgerechnet."
            path={`/admin/users/${user.id}/lock`}
            destructive
            variant="destructive"
            successMessage="Konto gesperrt"
          />
        )
      ) : null}
      {canRoles && !self ? (
        <ReasonAction
          label="Rolle ändern"
          title="Rolle ändern"
          description="Bestätige die Änderung mit deinem Passwort. Die Sitzungen des Nutzers werden beendet."
          path={`/admin/users/${user.id}/role`}
          method="PATCH"
          body={{ role, confirmPassword: password }}
          extraValid={password.length > 0 && role !== user.role}
          successMessage="Rolle geändert"
        >
          <Field label="Neue Rolle" htmlFor="role">
            <NativeSelect
              id="role"
              value={role}
              onChange={(e) => setRole(e.target.value as UserRole)}
            >
              {USER_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Dein Passwort" htmlFor="confirmPassword">
            <Input
              id="confirmPassword"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        </ReasonAction>
      ) : null}
      {canManage ? (
        <ReasonAction
          label="Limit setzen"
          title="Limit setzen (Support)"
          description="Staff-Änderungen gelten sofort, auch Erhöhungen. Leer lassen hebt das Limit auf."
          path={`/admin/users/${user.id}/limits`}
          method="PUT"
          body={{ type: limitType, amount: parsedLimit }}
          extraValid={limitValue.trim() === '' || parsedLimit !== null}
          successMessage="Limit gespeichert"
        >
          <Field label="Limit" htmlFor="limitType">
            <NativeSelect
              id="limitType"
              value={limitType}
              onChange={(e) => setLimitType(e.target.value as typeof limitType)}
            >
              {LIMIT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {LIMIT_LABELS[t]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Betrag (DEMO)" htmlFor="limitValue">
            <Input
              id="limitValue"
              inputMode="decimal"
              value={limitValue}
              onChange={(e) => setLimitValue(e.target.value)}
              placeholder="leer = aufheben"
            />
          </Field>
        </ReasonAction>
      ) : null}
      {canManage ? (
        <ReasonAction
          label="Sitzungen beenden"
          title="Alle Sitzungen beenden"
          path={`/admin/users/${user.id}/sessions/revoke`}
          successMessage="Sitzungen beendet"
        />
      ) : null}
    </div>
  );
}
