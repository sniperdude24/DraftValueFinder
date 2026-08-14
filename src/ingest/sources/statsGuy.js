// Trade-market player values: Stats Guy Fantasy (free, no key, 60 req/min).
// Values are derived from >1M real Sleeper-league trades and recalculated
// roughly daily — a behavioral market signal, distinct from ADP (mock
// drafts) and expert consensus (opinion). Attribution is required wherever
// the data is displayed; the UI carries it.
// Format non_sf_redraft matches this league (10-team, 1-QB, redraft).
import { fetchConditional, saveSnapshot } from '../util.js';

const URL = 'https://api.statsguyfantasy.com/api/v1/rankings?format=non_sf_redraft&limit=500';

export async function ingestStatsGuy({ force = false } = {}) {
  const got = await fetchConditional(URL, 'statsguy_values.json', { force });
  if (got.notModified) return { unchanged: true };

  const json = await got.res.json();
  if (!Array.isArray(json.rankings) || json.rankings.length < 50) {
    throw new Error(`Stats Guy: ${json.rankings?.length ?? 0} rankings — refusing suspicious snapshot`);
  }
  saveSnapshot('statsguy_values.json', json, {
    source: 'Stats Guy Fantasy trade-market values (non-SF redraft)',
    url: URL,
    kind: 'trade_market_values',
    detail: `${json.rankings.length} players, values as of ${json.asOf ?? '?'}, derived from real Sleeper-league trades`,
    ...got.validators,
  });
  return { players: json.rankings.length, as_of: json.asOf };
}
