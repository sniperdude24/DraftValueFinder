// Freshness policy for the data pipeline. Every source moves at least daily
// (ADP, expert consensus, trade values; in-season nflverse lands within a
// day of games), so one threshold serves both modes: rebuild when the
// database is older than 20 hours.
export const STALE_AFTER_MS = 20 * 60 * 60 * 1000;

export function isStale(builtAt, now = Date.now()) {
  if (!builtAt) return true;
  const t = Date.parse(builtAt);
  if (Number.isNaN(t)) return true;
  return now - t > STALE_AFTER_MS;
}
