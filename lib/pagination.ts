export function parsePagination(query: { page?: unknown; pageSize?: unknown; q?: unknown }) {
  const page = Math.max(1, Number.parseInt(String(query.page ?? '1'), 10) || 1);
  const pageSize = Math.min(100, Math.max(5, Number.parseInt(String(query.pageSize ?? '25'), 10) || 25));
  const q = String(query.q ?? '').trim().toLowerCase();
  return { page, pageSize, q };
}

export function paginateItems<T>(items: T[], page: number, pageSize: number) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize) || 1);
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    pagination: {
      page: safePage,
      pageSize,
      total,
      totalPages,
    },
  };
}
