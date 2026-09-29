import { AppError, type Paginated } from '@storm-bet/types';

/** Opaque cursor: the id of the last row of the previous page. */
export function decodeCursor(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined;
  try {
    const id = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('bad cursor');
    return id;
  } catch {
    throw new AppError('VALIDATION_ERROR', 'Ungültiger Seitenverweis.');
  }
}

export function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

/** Prisma cursor arguments for `take: limit + 1` pagination. */
export function cursorArgs(cursor: string | undefined, limit: number) {
  const id = decodeCursor(cursor);
  return {
    take: limit + 1,
    ...(id ? { cursor: { id }, skip: 1 } : {}),
  };
}

export function page<T extends { id: string }, R>(
  rows: T[],
  limit: number,
  map: (row: T) => R,
): Paginated<R> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items: items.map(map), nextCursor: hasMore && last ? encodeCursor(last.id) : null };
}
