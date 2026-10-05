import type { AdminUserDetailDto } from '@storm-bet/types';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@storm-bet/ui';
import { ChevronLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { KeyValue } from '@/components/admin/ui';
import { UserActions } from '@/components/admin/user-actions';
import { PageHeader } from '@/components/sportsbook/page-header';
import { formatDateTime, formatMoney } from '@/lib/format';
import { LIMIT_LABELS, ROLE_LABELS, USER_STATUS_LABELS } from '@/lib/labels';
import { serverApi, ServerApiError } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Nutzer' };

export default async function AdminUserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let user: AdminUserDetailDto;
  try {
    user = await serverApi<AdminUserDetailDto>(`/admin/users/${id}`);
  } catch (e) {
    if (e instanceof ServerApiError && e.status === 404) notFound();
    throw e;
  }
  return (
    <>
      <Link
        href="/admin/users"
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"
      >
        <ChevronLeft className="size-4" aria-hidden="true" /> Nutzer
      </Link>
      <PageHeader
        title={user.displayName}
        description={user.email}
        actions={
          <div className="flex gap-2">
            <Badge variant={user.role === 'USER' ? 'default' : 'accent'}>
              {ROLE_LABELS[user.role]}
            </Badge>
            <Badge variant={user.status === 'ACTIVE' ? 'success' : 'danger'}>
              {USER_STATUS_LABELS[user.status]}
            </Badge>
          </div>
        }
      />
      <UserActions user={user} />
      {user.lockedReason ? (
        <p className="rounded-md border border-down/30 bg-down-soft px-3 py-2 text-sm text-down">
          Gesperrt {user.lockedAt ? `am ${formatDateTime(user.lockedAt)}` : ''}: {user.lockedReason}
        </p>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Konto</CardTitle>
          <div className="flex gap-3 text-sm">
            <Link
              href={`/admin/bets?userId=${user.id}`}
              className="text-accent-strong hover:underline"
            >
              Wetten ({user.betCount})
            </Link>
            <Link
              href={`/admin/transactions?userId=${user.id}`}
              className="text-accent-strong hover:underline"
            >
              Transaktionen
            </Link>
            <Link
              href={`/admin/audit?targetId=${user.id}`}
              className="text-accent-strong hover:underline"
            >
              Audit-Log
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          <KeyValue
            items={[
              [
                'ID',
                <span key="id" className="font-mono text-xs">
                  {user.id}
                </span>,
              ],
              ['E-Mail bestätigt', user.emailVerified ? 'Ja' : 'Nein'],
              ['Land', user.country ?? '—'],
              ['Registriert', formatDateTime(user.createdAt)],
              ['Letzte Anmeldung', user.lastLoginAt ? formatDateTime(user.lastLoginAt) : '—'],
              ['Aktive Sitzungen', String(user.activeSessions)],
              ['KYC', user.kycStatus],
              ['Guthaben gesamt', user.wallet ? formatMoney(user.wallet.balance) : '—'],
              [
                'Reserviert / verfügbar',
                user.wallet
                  ? `${formatMoney(user.wallet.reserved)} / ${formatMoney(user.wallet.available)}`
                  : '—',
              ],
            ]}
          />
        </CardContent>
      </Card>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Limits</CardTitle>
          </CardHeader>
          <CardContent>
            {user.limits.length === 0 ? (
              <p className="text-sm text-fg-muted">Keine Limits gesetzt.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {user.limits.map((l) => (
                  <li key={l.type} className="flex justify-between gap-3">
                    <span>{LIMIT_LABELS[l.type]}</span>
                    <span className="tabular text-fg-muted">
                      {formatMoney(l.amount)}
                      {l.pendingAmount != null
                        ? ` → ${l.pendingAmount < 0 ? 'aufheben' : formatMoney(l.pendingAmount)}`
                        : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Selbstsperre</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {user.selfExclusion.active ? (
              <Badge variant="warning">
                Aktiv{' '}
                {user.selfExclusion.endsAt
                  ? `bis ${formatDateTime(user.selfExclusion.endsAt)}`
                  : '(unbefristet)'}
              </Badge>
            ) : (
              <span className="text-fg-muted">Keine aktive Selbstsperre.</span>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
