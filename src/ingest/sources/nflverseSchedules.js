// Game results: nflverse schedules (games.csv).
//
// WHY: the weekly stats file says a player faced CHI in week 17. It does not
// say whether the game was home or away, what it finished, or who won. A
// roster line that reads "Final W 42-38 vs Chi" needs all three, and inventing
// any of them is exactly what this app must never do.
//
// The join is EXACT, not fuzzy: the weekly stats file carries the same
// `game_id` this file is keyed by (`2025_17_DAL_WAS`), so results attach by
// primary key with no name, team or date matching anywhere in the path.
//
// TWO DEPARTURES FROM THE OTHER nflverse SOURCES, both deliberate:
//
//  1. ONE SNAPSHOT COVERS EVERY SEASON. The stats and snap files are
//     year-suffixed and a completed season's copy is skipped on refresh;
//     this file holds 1999 to now in 2.1 MB, so it is fetched unconditionally
//     and must never be skipped as "completed" — the current season's rows
//     change every week.
//
//  2. STORED RAW, NOT REDUCED. The red-zone snapshot is derived before it is
//     written, which is why it needs a REDUCER_VERSION to stop a 304 pinning
//     it to superseded counting rules. A raw CSV cannot go stale that way,
//     and 2.1 MB does not justify inheriting the hazard.
import { fetchConditional, saveSnapshot } from '../util.js';

const URL = 'https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv';
export const SCHEDULES_SNAPSHOT = 'games.csv';

export async function ingestSchedules({ force = false } = {}) {
  const got = await fetchConditional(URL, SCHEDULES_SNAPSHOT, { force, timeoutMs: 120000 });
  if (got.notModified) return { unchanged: true };

  const csv = await got.res.text();
  // Guard the columns the result line actually depends on. A silently
  // reshaped upstream file would otherwise turn every result into a blank.
  for (const col of ['game_id', 'home_team', 'home_score', 'away_team', 'away_score']) {
    if (!csv.startsWith('game_id') || !csv.slice(0, 2000).includes(col)) {
      throw new Error(`nflverse schedules: unexpected CSV header (missing ${col})`);
    }
  }
  saveSnapshot(SCHEDULES_SNAPSHOT, csv, {
    source: 'nflverse (game schedules and final scores, all seasons)',
    url: URL,
    kind: 'schedules',
    ...got.validators,
  });
  return { bytes: csv.length };
}
