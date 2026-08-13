// Ingestion orchestrator. Each source is independent: one failing source
// never blocks the others — we report per-source status and keep whatever
// snapshot already exists on disk for a failed source.
//
// Season awareness: the Sleeper state is fetched first to decide which
// stats years matter. The previous season is always kept (draft-mode stats
// and in-season trend baseline); during the regular/post season the current
// year's files are attempted too — a 404 there just means nflverse hasn't
// published week 1 yet, which is expected and non-fatal.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { RAW_DIR } from './util.js';
import { ingestFfcAdp } from './sources/ffcAdp.js';
import { ingestFantasyPros, ingestFantasyProsROS } from './sources/fantasyPros.js';
import { ingestWeeklyStats, ingestSnapCounts } from './sources/nflverse.js';
import { ingestSleeperPlayers, ingestSleeperState } from './sources/sleeper.js';
import { ingestStatsGuy } from './sources/statsGuy.js';

export async function runIngest({ log = console } = {}) {
  // State first — it decides the stats years.
  let state = null;
  try {
    state = await ingestSleeperState();
    log.log(`OK   Sleeper season state: ${state.season} ${state.season_type} wk${state.week}`);
  } catch (err) {
    log.error(`FAIL Sleeper season state: ${err.message}`);
  }
  const season = Number(state?.season ?? new Date().getFullYear());
  const prevSeason = season - 1;
  const inSeason = ['regular', 'post'].includes(state?.season_type);

  const sources = [
    ['FFC ADP (PPR 10-team)', ingestFfcAdp],
    ['FantasyPros draft consensus', ingestFantasyPros],
    ['FantasyPros rest-of-season consensus', ingestFantasyProsROS],
    ['Sleeper player metadata', ingestSleeperPlayers],
    ['Stats Guy trade-market values', ingestStatsGuy],
    [`nflverse weekly stats ${prevSeason}`, () => ingestWeeklyStats(prevSeason),
      // Skip the big download when the previous season's snapshot already
      // exists — completed seasons don't change.
      existsSync(join(RAW_DIR, `stats_player_week_${prevSeason}.csv`))],
    [`nflverse snap counts ${prevSeason}`, () => ingestSnapCounts(prevSeason),
      existsSync(join(RAW_DIR, `snap_counts_${prevSeason}.csv`))],
  ];
  if (inSeason) {
    sources.push(
      [`nflverse weekly stats ${season}`, () => ingestWeeklyStats(season)],
      [`nflverse snap counts ${season}`, () => ingestSnapCounts(season)],
    );
  }

  const active = sources.filter(([, , skip]) => !skip);
  for (const [name, , skip] of sources) if (skip) log.log(`SKIP ${name}: snapshot already on disk (completed season)`);

  const results = await Promise.allSettled(active.map(([, fn]) => fn()));
  let failures = 0;
  results.forEach((r, i) => {
    const name = active[i][0];
    if (r.status === 'fulfilled') log.log(`OK   ${name}: ${JSON.stringify(r.value)}`);
    else { failures++; log.error(`FAIL ${name}: ${r.reason?.message ?? r.reason}`); }
  });
  log.log(failures ? `${failures} source(s) failed — existing snapshots (if any) remain in use.` : 'All sources ingested.');
  return { failures, total: active.length, state };
}

// CLI entry: `node src/ingest/fetchAll.js`
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const { failures, total } = await runIngest();
  process.exit(failures === total ? 1 : 0);
}
