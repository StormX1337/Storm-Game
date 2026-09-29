'use client';

import useSWR from 'swr';

import {
  KeysPanel,
  LeaguesPanel,
  LogsPanel,
  MarketsPanel,
  PerformancePanel,
  SystemPanel,
  ThresholdsPanel,
  UsagePanel,
  UsersPanel,
} from '@/components/admin/panels';
import { Notice, PageHeader } from '@/components/common';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { User } from '@/lib/types';

const TABS = [
  ['system', 'System', SystemPanel],
  ['keys', 'API keys', KeysPanel],
  ['leagues', 'Leagues', LeaguesPanel],
  ['markets', 'Markets', MarketsPanel],
  ['thresholds', 'Thresholds', ThresholdsPanel],
  ['users', 'Users', UsersPanel],
  ['usage', 'API usage', UsagePanel],
  ['logs', 'Logs', LogsPanel],
  ['performance', 'Model performance', PerformancePanel],
] as const;

export default function AdminPage() {
  const { data: me } = useSWR<User>('/api/auth/me');
  if (me && me.role !== 'admin') {
    return <Notice tone="warn">Administrators only.</Notice>;
  }
  return (
    <>
      <PageHeader
        title="Admin"
        subtitle="Data sources, leagues, markets, limits, users and system health."
      />
      <Tabs defaultValue="system">
        <TabsList className="w-full md:w-auto">
          {TABS.map(([value, label]) => (
            <TabsTrigger key={value} value={value}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        {TABS.map(([value, , Panel]) => (
          <TabsContent key={value} value={value}>
            <Panel />
          </TabsContent>
        ))}
      </Tabs>
    </>
  );
}
