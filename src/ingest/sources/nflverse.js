// Statistical database: nflverse (official play-by-play derived, free).
// - stats_player_week_2025.csv: weekly per-player stats (targets, carries,
//   receptions, yards, TDs, PPR points, ...) for the 2025 season.
// - snap_counts_2025.csv: weekly offensive snap counts / percentages.
import { fetchText, saveSnapshot } from '../util.js';

const BASE = 'https://github.com/nflverse/nflverse-data/releases/download';
const WEEKLY_URL = `${BASE}/stats_player/stats_player_week_2025.csv`;
const SNAPS_URL = `${BASE}/snap_counts/snap_counts_2025.csv`;

export async function ingestWeeklyStats() {
  const csv = await fetchText(WEEKLY_URL, { timeoutMs: 180000 });
  if (!csv.startsWith('player_id') && !csv.includes(',week,')) {
    throw new Error('nflverse weekly stats: unexpected CSV header');
  }
  saveSnapshot('stats_player_week_2025.csv', csv, {
    source: 'nflverse (2025 season weekly player stats)',
    url: WEEKLY_URL,
    kind: 'weekly_stats',
  });
  return { bytes: csv.length };
}

export async function ingestSnapCounts() {
  const csv = await fetchText(SNAPS_URL, { timeoutMs: 180000 });
  if (!csv.includes('offense_snaps')) {
    throw new Error('nflverse snap counts: unexpected CSV header');
  }
  saveSnapshot('snap_counts_2025.csv', csv, {
    source: 'nflverse (2025 season snap counts)',
    url: SNAPS_URL,
    kind: 'snap_counts',
  });
  return { bytes: csv.length };
}
