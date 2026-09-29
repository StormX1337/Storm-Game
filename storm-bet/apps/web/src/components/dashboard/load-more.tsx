'use client';

import type { Paginated } from '@storm-bet/types';
import { Button, toast } from '@storm-bet/ui';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api-client';

/**
 * Cursor pagination for server-rendered lists: the first page arrives with the
 * HTML, later pages are appended client-side.
 */
export function LoadMore<T>({
  path,
  initialCursor,
  render,
  asRow = false,
}: {
  path: string;
  initialCursor: string | null;
  render: (items: T[]) => React.ReactNode;
  /** Render the button inside a table row (for use within <tbody>). */
  asRow?: boolean;
}) {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  if (!cursor && items.length === 0) return null;
  const load = async () => {
    if (!cursor) return;
    setLoading(true);
    try {
      const sep = path.includes('?') ? '&' : '?';
      const page = await api<Paginated<T>>(`${path}${sep}cursor=${encodeURIComponent(cursor)}`);
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setLoading(false);
    }
  };
  return (
    <>
      {render(items)}
      {cursor ? (
        asRow ? (
          <tr>
            <td colSpan={99} className="py-3 text-center">
              <Button variant="outline" onClick={() => void load()} loading={loading}>
                Mehr laden
              </Button>
            </td>
          </tr>
        ) : (
          <div className="flex justify-center">
            <Button variant="outline" onClick={() => void load()} loading={loading}>
              Mehr laden
            </Button>
          </div>
        )
      ) : null}
    </>
  );
}
