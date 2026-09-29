'use client';

import type {
  AdminCasinoGameDto,
  AdminCasinoRoundDto,
  AdminCasinoSessionDto,
  CasinoGameStatus,
} from '@storm-bet/types';
import { hasPermission, Permission } from '@storm-bet/types';
import {
  Badge,
  Card,
  Table,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Td,
  Th,
} from '@storm-bet/ui';
import { GAME_TYPE_LABELS } from '@/components/casino/labels';
import { formatDateTime, formatMoney } from '@/lib/format';
import { useSession } from '../providers/session';
import { ReasonAction } from './reason-action';

const STATUS: Record<
  CasinoGameStatus,
  { label: string; variant: 'success' | 'warning' | 'danger' }
> = {
  ACTIVE: { label: 'Aktiv', variant: 'success' },
  MAINTENANCE: { label: 'Wartung', variant: 'warning' },
  DISABLED: { label: 'Deaktiviert', variant: 'danger' },
};

export interface CasinoAdminData {
  games: AdminCasinoGameDto[];
  categories: { key: string; name: string; sortOrder: number; isActive: boolean }[];
  providers: {
    key: string;
    name: string;
    isSimulated: boolean;
    isActive: boolean;
    games: number;
  }[];
  sessions: AdminCasinoSessionDto[];
  rounds: AdminCasinoRoundDto[];
}

export function CasinoAdmin({ data }: { data: CasinoAdminData }) {
  const { user } = useSession();
  const manage = !!user && hasPermission(user.role, Permission.CASINO_MANAGE);
  const act = (
    label: string,
    path: string,
    body: Record<string, unknown>,
    method: 'POST' | 'PATCH' = 'PATCH',
    destructive = false,
  ) =>
    manage ? (
      <ReasonAction
        label={label}
        title={label}
        path={path}
        method={method}
        body={body}
        size="sm"
        variant={destructive ? 'destructive' : 'outline'}
        destructive={destructive}
        successMessage="Gespeichert"
      />
    ) : null;

  return (
    <Tabs defaultValue="games">
      <TabsList aria-label="Casino-Verwaltung">
        <TabsTrigger value="games">Spiele</TabsTrigger>
        <TabsTrigger value="categories">Kategorien</TabsTrigger>
        <TabsTrigger value="providers">Anbieter</TabsTrigger>
        <TabsTrigger value="sessions">Sitzungen</TabsTrigger>
        <TabsTrigger value="rounds">Runden</TabsTrigger>
      </TabsList>

      <TabsContent value="games">
        <Card className="mt-3 overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <Th>Spiel</Th>
                <Th>Typ / Kategorien</Th>
                <Th>Status</Th>
                <Th className="text-right">RTP</Th>
                <Th className="text-right">Runden 7 T</Th>
                <Th>Aktionen</Th>
              </tr>
            </thead>
            <tbody>
              {data.games.map((g) => (
                <tr key={g.id}>
                  <Td>
                    <p className="font-medium">{g.name}</p>
                    <p className="text-xs text-fg-subtle">{g.provider.name}</p>
                  </Td>
                  <Td className="text-xs">
                    {GAME_TYPE_LABELS[g.type]} · {g.categories.join(', ')}
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      <Badge variant={STATUS[g.status].variant}>{STATUS[g.status].label}</Badge>
                      {g.isFeatured ? <Badge variant="accent">Empfohlen</Badge> : null}
                      {g.isNew ? <Badge variant="outline">Neu</Badge> : null}
                    </div>
                  </Td>
                  <Td className="tabular text-right">{g.rtp.toFixed(2)} %</Td>
                  <Td className="tabular text-right">{g.roundsLast7d}</Td>
                  <Td>
                    <div className="flex flex-wrap gap-1.5">
                      {(['ACTIVE', 'MAINTENANCE', 'DISABLED'] as const)
                        .filter((s) => s !== g.status)
                        .map((s) => (
                          <span key={s}>
                            {act(
                              STATUS[s].label,
                              `/admin/casino/games/${g.id}`,
                              { status: s },
                              'PATCH',
                              s === 'DISABLED',
                            )}
                          </span>
                        ))}
                      {act(
                        g.isFeatured ? 'Nicht empfehlen' : 'Empfehlen',
                        `/admin/casino/games/${g.id}`,
                        { isFeatured: !g.isFeatured },
                      )}
                      {act(g.isNew ? 'Nicht neu' : 'Als neu', `/admin/casino/games/${g.id}`, {
                        isNew: !g.isNew,
                      })}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </TabsContent>

      <TabsContent value="categories">
        <Card className="mt-3 overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <Th>Schlüssel</Th>
                <Th>Name</Th>
                <Th className="text-right">Reihenfolge</Th>
                <Th>Status</Th>
                <Th>Aktion</Th>
              </tr>
            </thead>
            <tbody>
              {data.categories.map((c) => (
                <tr key={c.key}>
                  <Td className="font-mono text-xs">{c.key}</Td>
                  <Td>{c.name}</Td>
                  <Td className="tabular text-right">{c.sortOrder}</Td>
                  <Td>
                    <Badge variant={c.isActive ? 'success' : 'default'}>
                      {c.isActive ? 'Sichtbar' : 'Ausgeblendet'}
                    </Badge>
                  </Td>
                  <Td>
                    {act(
                      c.isActive ? 'Ausblenden' : 'Einblenden',
                      `/admin/casino/categories/${c.key}`,
                      { isActive: !c.isActive },
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </TabsContent>

      <TabsContent value="providers">
        <Card className="mt-3 overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <Th>Anbieter</Th>
                <Th className="text-right">Spiele</Th>
                <Th>Art</Th>
                <Th>Status</Th>
                <Th>Aktion</Th>
              </tr>
            </thead>
            <tbody>
              {data.providers.map((p) => (
                <tr key={p.key}>
                  <Td>
                    <p className="font-medium">{p.name}</p>
                    <p className="font-mono text-xs text-fg-subtle">{p.key}</p>
                  </Td>
                  <Td className="tabular text-right">{p.games}</Td>
                  <Td>
                    {p.isSimulated ? (
                      <Badge variant="warning">Demo / simuliert</Badge>
                    ) : (
                      <Badge>Extern</Badge>
                    )}
                  </Td>
                  <Td>
                    <Badge variant={p.isActive ? 'success' : 'danger'}>
                      {p.isActive ? 'Aktiv' : 'Gesperrt'}
                    </Badge>
                  </Td>
                  <Td>
                    {act(
                      p.isActive ? 'Sperren' : 'Aktivieren',
                      `/admin/casino/providers/${p.key}`,
                      { isActive: !p.isActive },
                      'PATCH',
                      p.isActive,
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="border-t border-border p-3 text-xs text-fg-muted">
            Externe Anbieter werden ausschließlich mit Lizenz und regulatorischer Prüfung angebunden
            (CasinoProvider-Schnittstelle).
          </p>
        </Card>
      </TabsContent>

      <TabsContent value="sessions">
        <Card className="mt-3 overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <Th>Nutzer</Th>
                <Th>Spiel</Th>
                <Th>Status</Th>
                <Th className="text-right">Runden</Th>
                <Th>Letzte Aktivität</Th>
                <Th>Aktion</Th>
              </tr>
            </thead>
            <tbody>
              {data.sessions.map((s) => (
                <tr key={s.id}>
                  <Td className="text-xs">{s.user.email}</Td>
                  <Td>{s.game.name}</Td>
                  <Td>
                    <Badge variant={s.status === 'OPEN' ? 'success' : 'default'}>
                      {s.status === 'OPEN' ? 'Offen' : 'Beendet'}
                    </Badge>
                    {s.closedReason ? (
                      <p className="mt-1 text-xs text-fg-subtle">{s.closedReason}</p>
                    ) : null}
                  </Td>
                  <Td className="tabular text-right">{s.rounds}</Td>
                  <Td className="whitespace-nowrap text-xs">{formatDateTime(s.lastActivityAt)}</Td>
                  <Td>
                    {s.status === 'OPEN'
                      ? act('Beenden', `/admin/casino/sessions/${s.id}/close`, {}, 'POST', true)
                      : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </TabsContent>

      <TabsContent value="rounds">
        <Card className="mt-3 overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <Th>Runde</Th>
                <Th>Nutzer</Th>
                <Th>Spiel</Th>
                <Th className="text-right">Einsatz</Th>
                <Th className="text-right">Auszahlung</Th>
                <Th>Status</Th>
                <Th>Zeit</Th>
                <Th>Aktion</Th>
              </tr>
            </thead>
            <tbody>
              {data.rounds.map((r) => (
                <tr key={r.id}>
                  <Td className="font-mono text-xs" title={r.id}>
                    {r.id.slice(0, 8)}
                  </Td>
                  <Td className="text-xs">{r.user.email}</Td>
                  <Td>{r.gameName}</Td>
                  <Td className="tabular text-right">{formatMoney(r.stake)}</Td>
                  <Td className="tabular text-right">{formatMoney(r.payout)}</Td>
                  <Td>
                    <Badge
                      variant={
                        r.status === 'SETTLED'
                          ? 'success'
                          : r.status === 'OPEN'
                            ? 'warning'
                            : 'outline'
                      }
                    >
                      {r.status === 'SETTLED'
                        ? 'Abgerechnet'
                        : r.status === 'OPEN'
                          ? 'Offen'
                          : 'Erstattet'}
                    </Badge>
                  </Td>
                  <Td className="whitespace-nowrap text-xs">{formatDateTime(r.createdAt)}</Td>
                  <Td>
                    {r.status === 'OPEN'
                      ? act('Erstatten', `/admin/casino/rounds/${r.id}/refund`, {}, 'POST', true)
                      : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </TabsContent>
    </Tabs>
  );
}
