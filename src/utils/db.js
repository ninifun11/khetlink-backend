import { HttpError } from './http.js';

/**
 * Page through a Supabase query (PostgREST caps responses at 1000 rows by default).
 * build(from, to) must return a query that already has .range(from, to) applied.
 */
export async function fetchAll(build, pageSize = 1000, maxRows = 20000) {
  const rows = [];
  for (let from = 0; from < maxRows; from += pageSize) {
    const { data, error } = await build(from, from + pageSize - 1);
    if (error) throw new HttpError(500, error.message);
    rows.push(...data);
    if (data.length < pageSize) break;
  }
  return rows;
}
