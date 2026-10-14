export const isoDay = (d) => new Date(d).toISOString().slice(0, 10);

/** ['2025-01-01', ...] for the last n days including today (UTC) */
export function lastNDays(n) {
  const out = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    out.push(isoDay(d));
  }
  return out;
}

export function daysAgoISO(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return isoDay(d);
}
