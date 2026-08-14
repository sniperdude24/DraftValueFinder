// Weekly PPR projections: Sleeper public API (free, no key).
// EXTERNAL projections — the app never generates its own numbers.
// Draft prep fetches week 1 of the upcoming season (already published);
// in-season the current week rides the auto-refresh cadence.
import { fetchJson, saveSnapshot } from '../util.js';
import { projectionWeek } from '../../normalize/projections.js';

export async function ingestSleeperProjections(sleeperState) {
  const { season, week } = projectionWeek(sleeperState);
  const url = `https://api.sleeper.app/v1/projections/nfl/regular/${season}/${week}`;
  const raw = await fetchJson(url, { timeoutMs: 120000 });
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
  });
  return { season, week, players: Object.keys(projections).length };
}
