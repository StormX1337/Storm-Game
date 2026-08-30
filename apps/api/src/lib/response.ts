import type { ApiSuccess, PaginationMeta } from '@storm/types';

export function ok<T>(data: T, meta?: PaginationMeta): ApiSuccess<T> {
  return meta ? { success: true, data, meta } : { success: true, data };
}

export function paginated<T>(items: T[], total: number, page: number, perPage: number): ApiSuccess<T[]> {
  return {
    success: true,
    data: items,
    meta: {
      page,
      perPage,
      total,
      totalPages: perPage > 0 ? Math.max(1, Math.ceil(total / perPage)) : 1,
    },
  };
}

/** Prisma `skip`/`take` for a 1-indexed page. */
export function pageArgs(page: number, perPage: number): { skip: number; take: number } {
  return { skip: (page - 1) * perPage, take: perPage };
}
