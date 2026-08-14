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
import { ingestRedZone } from './sources/nflversePbp.js';
import { ingestSleeperPlayers, ingestSleeperState } from './sources/sleeper.js';
import { ingestStatsGuy } from './sources/statsGuy.js';
import { ingestSleeperProjections } from './sources/sleeperProjections.js';

export async function runIngest({ log = console, force = false } = {}) {
  const opts = { force };
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
    ['FFC ADP (PPR 10-team)', () => ingestFfcAdp(opts)],
    ['FantasyPros draft consensus', ingestFantasyPros],
    ['FantasyPros rest-of-season consensus', ingestFantasyProsROS],
    ['Sleeper player metadata', () => ingestSleeperPlayers(opts)],
    ['Stats Guy trade-market values', () => ingestStatsGuy(opts)],
    ['Sleeper weekly projections', () => ingestSleeperProjections(state, opts)],
    [`nflverse weekly stats ${prevSeason}`, () => ingestWeeklyStats(prevSeason, opts),
      // Skip the big download when the previous season's snapshot already
      // exists — completed seasons don't change.
      existsSync(join(RAW_DIR, `stats_player_week_${prevSeason}.csv`))],
    [`nflverse snap counts ${prevSeason}`, () => ingestSnapCounts(prevSeason, opts),
      existsSync(join(RAW_DIR, `snap_counts_${prevSeason}.csv`))],
    [`nflverse red-zone usage ${prevSeason}`, () => ingestRedZone(prevSeason, opts),
      existsSync(join(RAW_DIR, `redzone_${prevSeason}.json`))],
  ];
  if (inSeason) {
    sources.push(
      [`nflverse weekly stats ${season}`, () => ingestWeeklyStats(season, opts)],
      [`nflverse snap counts ${season}`, () => ingestSnapCounts(season, opts)],
      [`nflverse red-zone usage ${season}`, () => ingestRedZone(season, opts)],
    );
  }

  const active = sources.filter(([, , skip]) => !skip);
  for (const [name, , skip] of sources) if (skip) log.log(`SKIP ${name}: snapshot already on disk (completed season)`);

  const results = await Promise.allSettled(active.map(([, fn]) => fn()));
  let failures = 0, unchanged = 0;
  results.forEach((r, i) => {
    const name = active[i][0];
    if (r.status === 'rejected') {
      failures++;
      log.error(`FAIL ${name}: ${r.reason?.message ?? r.reason}`);
    } else if (r.value?.unchanged) {
      // The source confirmed our copy is current and sent no body. This is
      // the good case, not a no-op — say so, or a refresh that downloads
      // nothing looks like a refresh that did nothing.
      unchanged++;
      log.log(`SAME ${name}: unchanged upstream (304, no data transferred)`);
    } else {
      log.log(`OK   ${name}: ${JSON.stringify(r.value)}`);
    }
  });
  const downloaded = active.length - failures - unchanged;
  log.log(failures
    ? `${failures} source(s) failed — existing snapshots (if any) remain in use.`
    : `All sources ingested — ${downloaded} updated, ${unchanged} already current.`);
  return { failures, unchanged, downloaded, total: active.length, state };
}

// CLI entry: `node src/ingest/fetchAll.js [--force]`
// --force ignores cached validators and re-downloads everything.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const { failures, total } = await runIngest({ force: process.argv.includes('--force') });
  process.exit(failures === total ? 1 : 0);
}
