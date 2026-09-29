import type { AdminCasinoRoundDto, AdminCasinoSessionDto, Paginated } from '@storm-bet/types';
import type { Metadata } from 'next';
import { CasinoAdmin, type CasinoAdminData } from '@/components/admin/casino-admin';
import { PageHeader } from '@/components/sportsbook/page-header';
import { serverApi } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Casino' };

export default async function AdminCasinoPage() {
  const [games, categories, providers, sessions, rounds] = await Promise.all([
    serverApi<CasinoAdminData['games']>('/admin/casino/games'),
    serverApi<CasinoAdminData['categories']>('/admin/casino/categories'),
    serverApi<CasinoAdminData['providers']>('/admin/casino/providers'),
    serverApi<Paginated<AdminCasinoSessionDto>>('/admin/casino/sessions?limit=50'),
    serverApi<Paginated<AdminCasinoRoundDto>>('/admin/casino/rounds?limit=50'),
  ]);
  return (
    <>
      <PageHeader
        title="Casino"
        description="Spiele, Kategorien, Anbieter, Sitzungen und Demo-Runden. Änderungen werden mit Begründung im Audit-Log gespeichert."
      />
      <CasinoAdmin
        data={{ games, categories, providers, sessions: sessions.items, rounds: rounds.items }}
      />
    </>
  );
}
