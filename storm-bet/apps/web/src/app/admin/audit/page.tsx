import type { AuditLogDto, Paginated } from '@storm-bet/types';
import { Badge, Card, EmptyState, Input, Table, Td, Th } from '@storm-bet/ui';
import { ScrollText } from 'lucide-react';
import type { Metadata } from 'next';
import { FilterBar, NextPage, query } from '@/components/admin/ui';
import { PageHeader } from '@/components/sportsbook/page-header';
import { formatDateTime } from '@/lib/format';
import { ROLE_LABELS } from '@/lib/labels';
import { serverApi } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Audit-Log' };

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const page = await serverApi<Paginated<AuditLogDto>>(
    `/admin/audit-logs${query(params, ['action', 'actorId', 'targetType', 'targetId', 'cursor'])}`,
  );
  return (
    <>
      <PageHeader
        title="Audit-Log"
        description="Nur anhängend: Einträge können über keine Schnittstelle geändert oder gelöscht werden (Datenbank-Trigger)."
      />
      <FilterBar>
        <Input
          name="action"
          defaultValue={params.action}
          placeholder="Aktion, z. B. admin."
          className="w-48"
          aria-label="Aktion"
        />
        <Input
          name="targetType"
          defaultValue={params.targetType}
          placeholder="Zieltyp (user, bet …)"
          className="w-44"
          aria-label="Zieltyp"
        />
        <Input
          name="targetId"
          defaultValue={params.targetId}
          placeholder="Ziel-ID"
          className="w-72"
          aria-label="Ziel-ID"
        />
        <Input
          name="actorId"
          defaultValue={params.actorId}
          placeholder="Akteur-ID"
          className="w-72"
          aria-label="Akteur-ID"
        />
      </FilterBar>
      <Card className="overflow-hidden">
        {page.items.length === 0 ? (
          <EmptyState icon={<ScrollText />} title="Keine Einträge" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Zeit</Th>
                <Th>Akteur</Th>
                <Th>Aktion</Th>
                <Th>Ziel</Th>
                <Th>IP</Th>
                <Th>Details</Th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((a) => (
                <tr key={a.id}>
                  <Td className="whitespace-nowrap text-xs text-fg-muted">
                    {formatDateTime(a.createdAt)}
                  </Td>
                  <Td className="text-xs">
                    {a.actorEmail ?? 'System'}
                    {a.actorRole ? (
                      <Badge className="ml-1.5">{ROLE_LABELS[a.actorRole]}</Badge>
                    ) : null}
                  </Td>
                  <Td className="font-mono text-xs">{a.action}</Td>
                  <Td className="text-xs">
                    {a.targetType}
                    {a.targetId ? (
                      <span className="block font-mono text-[11px] text-fg-subtle">
                        {a.targetId}
                      </span>
                    ) : null}
                  </Td>
                  <Td className="font-mono text-xs text-fg-muted">{a.ip ?? '—'}</Td>
                  <Td className="max-w-md">
                    <code className="line-clamp-2 break-all text-[11px] text-fg-subtle">
                      {JSON.stringify(a.metadata)}
                    </code>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <NextPage page={page} basePath="/admin/audit" params={params} />
    </>
  );
}
