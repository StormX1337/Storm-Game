import type { Paginated } from '@storm-bet/types';
import { Badge, Button, Card } from '@storm-bet/ui';
import Link from 'next/link';

export function FilterBar({ children, action }: { children: React.ReactNode; action?: string }) {
  return (
    <Card className="p-3">
      <form method="get" action={action} className="flex flex-wrap items-end gap-2">
        {children}
        <Button type="submit" size="md" variant="secondary">
          Filtern
        </Button>
      </form>
    </Card>
  );
}

export function NextPage({
  page,
  basePath,
  params,
}: {
  page: Paginated<unknown>;
  basePath: string;
  params: Record<string, string | undefined>;
}) {
  if (!page.nextCursor) return null;
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v && k !== 'cursor') search.set(k, v);
  search.set('cursor', page.nextCursor);
  return (
    <div className="flex justify-end">
      <Button variant="outline" asChild>
        <Link href={`${basePath}?${search.toString()}`}>Nächste Seite</Link>
      </Button>
    </div>
  );
}

export function YesNo({ value }: { value: boolean }) {
  return <Badge variant={value ? 'success' : 'default'}>{value ? 'Ja' : 'Nein'}</Badge>;
}

export function KeyValue({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt className="text-xs text-fg-subtle">{k}</dt>
          <dd className="mt-0.5 text-sm">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Builds an API query string from page search params, dropping empties. */
export function query(
  params: Record<string, string | string[] | undefined>,
  allowed: string[],
): string {
  const search = new URLSearchParams();
  for (const key of allowed) {
    const value = params[key];
    if (typeof value === 'string' && value.trim()) search.set(key, value.trim());
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}
