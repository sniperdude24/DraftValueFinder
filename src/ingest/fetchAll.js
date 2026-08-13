// Ingestion orchestrator. Each source is independent: one failing source
// never blocks the others — we report per-source status and keep whatever
// snapshot already exists on disk for a failed source.
import { ingestFfcAdp } from './sources/ffcAdp.js';
import { ingestFantasyPros } from './sources/fantasyPros.js';
import { ingestWeeklyStats, ingestSnapCounts } from './sources/nflverse.js';
import { ingestSleeperPlayers, ingestSleeperState } from './sources/sleeper.js';

const SOURCES = [
  ['FFC ADP (PPR 10-team 2026)', ingestFfcAdp],
  ['FantasyPros expert consensus', ingestFantasyPros],
  ['nflverse weekly stats 2025', ingestWeeklyStats],
  ['nflverse snap counts 2025', ingestSnapCounts],
  ['Sleeper player metadata', ingestSleeperPlayers],
  ['Sleeper season state', ingestSleeperState],
];

const results = await Promise.allSettled(SOURCES.map(([, fn]) => fn()));
let failures = 0;
results.forEach((r, i) => {
  const name = SOURCES[i][0];
  if (r.status === 'fulfilled') {
    console.log(`OK   ${name}: ${JSON.stringify(r.value)}`);
  } else {
    failures++;
    console.error(`FAIL ${name}: ${r.reason?.message ?? r.reason}`);
  }
});
console.log(failures ? `${failures} source(s) failed — existing snapshots (if any) remain in use.` : 'All sources ingested.');
process.exit(failures === SOURCES.length ? 1 : 0);
