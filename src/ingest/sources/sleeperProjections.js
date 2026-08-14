// Weekly PPR projections: Sleeper public API (free, no key).
// EXTERNAL projections — the app never generates its own numbers.
// Draft prep fetches week 1 of the upcoming season (already published);
// in-season the current week rides the auto-refresh cadence.
import { fetchConditional, snapshotValidators, saveSnapshot } from '../util.js';
import { projectionWeek } from '../../normalize/projections.js';

export async function ingestSleeperProjections(sleeperState, { force = false } = {}) {
  const { season, week } = projectionWeek(sleeperState);
  const url = `https://api.sleeper.app/v1/projections/nfl/regular/${season}/${week}`;

  // The URL carries the week, so when the week rolls over the cached
  // validators describe a different resource entirely — always refetch then.
  const prev = snapshotValidators('sleeper_projections.json');
  const differentWeek = !prev || prev.season !== season || prev.week !== week;
  const got = await fetchConditional(url, 'sleeper_projections.json',
    { force: force || differentWeek, timeoutMs: 120000 });
  if (got.notModified) return { season, week, unchanged: true };

  const raw = await got.res.json();
  const ids = Object.keys(raw);
  if (ids.length < 200) throw new Error(`Sleeper projections: only ${ids.length} entries — refusing suspicious snapshot`);
  // Keep only entries that actually project points (drops empty ADP stubs).
  const projections = {};
  for (const [id, stats] of Object.entries(raw)) {
    if (stats?.pts_ppr != null) projections[id] = stats;
  }
  saveSnapshot('sleeper_projections.json', { season, week, projections }, {
    source: `Sleeper weekly projections (external), ${season} week ${week}`,
    url,
    kind: 'projections',
    detail: `${Object.keys(projections).length} players with PPR projections`,
    season,
    week,
    ...got.validators,
  });
  return { season, week, players: Object.keys(projections).length };
}
