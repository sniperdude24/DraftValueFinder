// Statistical database: nflverse (official play-by-play derived, free).
// - stats_player_week_<year>.csv: weekly per-player stats (targets, carries,
//   receptions, yards, TDs, PPR points, ...)
// - snap_counts_<year>.csv: weekly offensive snap counts / percentages.
//
// Snapshots are year-suffixed; during the season the current year's files
// are fetched (they appear on nflverse shortly after week 1 and update
// weekly), while the previous year's stay on disk as the trend baseline.
// These two files are the pipeline's heaviest stored payloads (8.3 MB and
// 2.3 MB in-season), and nflverse republishes them only after game days —
// so both are fetched conditionally and usually cost nothing.
import { fetchConditional, saveSnapshot } from '../util.js';

const BASE = 'https://github.com/nflverse/nflverse-data/releases/download';
const weeklyUrl = year => `${BASE}/stats_player/stats_player_week_${year}.csv`;
const snapsUrl = year => `${BASE}/snap_counts/snap_counts_${year}.csv`;

export async function ingestWeeklyStats(year, { force = false } = {}) {
  const url = weeklyUrl(year);
  const name = `stats_player_week_${year}.csv`;
  const got = await fetchConditional(url, name, { force, timeoutMs: 180000 });
  if (got.notModified) return { year, unchanged: true };

  const csv = await got.res.text();
  if (!csv.startsWith('player_id') && !csv.includes(',week,')) {
    throw new Error(`nflverse weekly stats ${year}: unexpected CSV header`);
  }
  saveSnapshot(name, csv, {
    source: `nflverse (${year} season weekly player stats)`,
    url,
    kind: 'weekly_stats',
    season: year,
    ...got.validators,
  });
  return { year, bytes: csv.length };
}

export async function ingestSnapCounts(year, { force = false } = {}) {
  const url = snapsUrl(year);
  const name = `snap_counts_${year}.csv`;
  const got = await fetchConditional(url, name, { force, timeoutMs: 180000 });
  if (got.notModified) return { year, unchanged: true };

  const csv = await got.res.text();
  if (!csv.includes('offense_snaps')) {
    throw new Error(`nflverse snap counts ${year}: unexpected CSV header`);
  }
  saveSnapshot(name, csv, {
    source: `nflverse (${year} season snap counts)`,
    url,
    kind: 'snap_counts',
    season: year,
    ...got.validators,
  });
  return { year, bytes: csv.length };
}
