import type { AdminUserDto, Paginated } from '@storm-bet/types';
import { USER_ROLES, USER_STATUSES } from '@storm-bet/types';
import { Badge, Card, EmptyState, Input, NativeSelect, Table, Td, Th } from '@storm-bet/ui';
import { Users } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { FilterBar, NextPage, query } from '@/components/admin/ui';
import { PageHeader } from '@/components/sportsbook/page-header';
import { formatDateTime, formatMoney } from '@/lib/format';
import { ROLE_LABELS, USER_STATUS_LABELS } from '@/lib/labels';
import { serverApi } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Nutzer' };

type Search = Record<string, string | undefined>;

export default async function AdminUsersPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const page = await serverApi<Paginated<AdminUserDto>>(
    `/admin/users${query(params, ['q', 'role', 'status', 'cursor'])}`,
  );
  return (
    <>
      <PageHeader title="Nutzer" description="Suche nach E-Mail, Anzeigename oder ID." />
      <FilterBar>
        <Input
          name="q"
          defaultValue={params.q}
          placeholder="Suche …"
          className="w-64"
          aria-label="Suche"
        />
        <NativeSelect
          name="role"
          defaultValue={params.role ?? ''}
          className="w-40"
          aria-label="Rolle"
        >
          <option value="">Alle Rollen</option>
          {USER_ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          name="status"
          defaultValue={params.status ?? ''}
          className="w-40"
          aria-label="Status"
        >
          <option value="">Alle Status</option>
          {USER_STATUSES.map((s) => (
            <option key={s} value={s}>
              {USER_STATUS_LABELS[s]}
            </option>
          ))}
        </NativeSelect>
      </FilterBar>
      <Card className="overflow-hidden">
        {page.items.length === 0 ? (
          <EmptyState icon={<Users />} title="Keine Nutzer gefunden" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Nutzer</Th>
                <Th>Rolle</Th>
                <Th>Status</Th>
                <Th className="text-right">Verfügbar</Th>
                <Th className="text-right">Wetten</Th>
                <Th>Registriert</Th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((u) => (
                <tr key={u.id} className="hover:bg-surface-2/50">
                  <Td>
                    <Link href={`/admin/users/${u.id}`} className="font-medium hover:text-accent">
                      {u.displayName}
                    </Link>
                    <p className="text-xs text-fg-muted">{u.email}</p>
                  </Td>
                  <Td>
                    <Badge variant={u.role === 'USER' ? 'default' : 'accent'}>
                      {ROLE_LABELS[u.role]}
                    </Badge>
                  </Td>
                  <Td>
                    <Badge variant={u.status === 'ACTIVE' ? 'success' : 'danger'}>
                      {USER_STATUS_LABELS[u.status]}
                    </Badge>
                  </Td>
                  <Td className="tabular text-right">
                    {u.wallet ? formatMoney(u.wallet.available, { unit: false }) : '—'}
                  </Td>
                  <Td className="tabular text-right">{u.betCount}</Td>
                  <Td className="whitespace-nowrap text-xs text-fg-muted">
                    {formatDateTime(u.createdAt)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <NextPage page={page} basePath="/admin/users" params={params} />
    </>
  );
}
