import type { ProviderHealthDto, SystemHealthDto } from '@storm-bet/types';
import { Badge, Card, CardContent, CardHeader, CardTitle, cn, Table, Td, Th } from '@storm-bet/ui';
import { formatDateTime, formatRelative } from '@/lib/format';

const STATE_VARIANT = {
  HEALTHY: 'success',
  DEGRADED: 'warning',
  DOWN: 'danger',
  UNKNOWN: 'default',
} as const;
const STATE_LABEL = {
  HEALTHY: 'Gesund',
  DEGRADED: 'Beeinträchtigt',
  DOWN: 'Ausgefallen',
  UNKNOWN: 'Unbekannt',
} as const;

export function SystemHealthCard({ health }: { health: SystemHealthDto }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Systemstatus</CardTitle>
        <Badge
          variant={
            health.status === 'ok' ? 'success' : health.status === 'degraded' ? 'warning' : 'danger'
          }
        >
          {health.status === 'ok'
            ? 'Betriebsbereit'
            : health.status === 'degraded'
              ? 'Eingeschränkt'
              : 'Gestört'}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-2">
        {health.components.map((c) => (
          <div key={c.name} className="flex items-center gap-3 text-sm">
            <span
              className={cn('size-2 rounded-full', c.ok ? 'bg-up' : 'bg-down')}
              aria-hidden="true"
            />
            <span className="font-medium">{c.name}</span>
            <span className="truncate text-xs text-fg-subtle">{c.detail ?? ''}</span>
            <span className="tabular ml-auto text-xs text-fg-muted">
              {c.latencyMs != null ? `${c.latencyMs} ms` : ''}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function QueuesCard({ health }: { health: SystemHealthDto }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle>Warteschlangen (Worker)</CardTitle>
      </CardHeader>
      <Table>
        <thead>
          <tr>
            <Th>Queue</Th>
            <Th className="text-right">Wartend</Th>
            <Th className="text-right">Aktiv</Th>
            <Th className="text-right">Geplant</Th>
            <Th className="text-right">Fehlgeschlagen</Th>
          </tr>
        </thead>
        <tbody>
          {health.queues.map((q) => (
            <tr key={q.name}>
              <Td className="font-mono text-xs">{q.name}</Td>
              <Td className="tabular text-right">{q.waiting}</Td>
              <Td className="tabular text-right">{q.active}</Td>
              <Td className="tabular text-right">{q.delayed}</Td>
              <Td className={cn('tabular text-right', q.failed > 0 && 'text-down')}>{q.failed}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

export function ProviderCard({ provider }: { provider: ProviderHealthDto }) {
  const errorRate = provider.requests
    ? ((provider.failures / provider.requests) * 100).toFixed(1)
    : '0.0';
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-semibold">{provider.name}</p>
        <Badge variant={STATE_VARIANT[provider.state]}>{STATE_LABEL[provider.state]}</Badge>
        {provider.isSimulated ? <Badge variant="warning">Simuliert</Badge> : null}
        <span className="ml-auto font-mono text-xs text-fg-subtle">{provider.key}</span>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-fg-subtle">Circuit Breaker</dt>
          <dd className="font-medium">{provider.circuit}</dd>
        </div>
        <div>
          <dt className="text-xs text-fg-subtle">Ø Latenz</dt>
          <dd className="tabular font-medium">
            {provider.avgLatencyMs != null ? `${provider.avgLatencyMs} ms` : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-fg-subtle">Anfragen / Fehlerquote</dt>
          <dd className="tabular font-medium">
            {provider.requests} / {errorRate} %
          </dd>
        </div>
        <div>
          <dt className="text-xs text-fg-subtle">Letzte Synchronisierung</dt>
          <dd className="font-medium">
            {provider.lastSyncAt ? formatRelative(provider.lastSyncAt) : '—'}
          </dd>
        </div>
      </dl>
      {provider.lastError ? (
        <p className="mt-3 rounded-md bg-down-soft px-3 py-2 text-xs text-down">
          Letzter Fehler {provider.lastErrorAt ? formatDateTime(provider.lastErrorAt) : ''}:{' '}
          {provider.lastError}
        </p>
      ) : null}
    </Card>
  );
}
