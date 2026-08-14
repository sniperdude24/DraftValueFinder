// Player metadata: Sleeper public API (free, no key).
// Canonical player list with team, position, age, experience, depth chart
// position, and injury status. Also the season state (current week etc).
import { fetchJson, fetchConditional, saveSnapshot } from '../util.js';

const PLAYERS_URL = 'https://api.sleeper.app/v1/players/nfl';
const STATE_URL = 'https://api.sleeper.app/v1/state/nfl';

export async function ingestSleeperPlayers({ force = false } = {}) {
  // Sleeper asks that this endpoint be called sparingly — it is a multi-MB
  // payload. The conditional request also skips the slimming pass below,
  // which is the expensive half of this function.
  const got = await fetchConditional(PLAYERS_URL, 'sleeper_players.json', { force, timeoutMs: 120000 });
  if (got.notModified) return { unchanged: true };

  const players = await got.res.json();
  const count = Object.keys(players).length;
  if (count < 1000) throw new Error(`Sleeper players: only ${count} players — refusing suspicious snapshot`);
  // Keep only fantasy-relevant fields to shrink the snapshot ~10x.
  const slim = {};
  for (const [id, p] of Object.entries(players)) {
    if (!p.position || !['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].includes(p.position)) continue;
    slim[id] = {
      full_name: p.full_name ?? (p.first_name && p.last_name ? `${p.first_name} ${p.last_name}` : null),
      position: p.position,
      team: p.team,
      age: p.age,
      years_exp: p.years_exp,
      status: p.status,
      injury_status: p.injury_status,
      depth_chart_position: p.depth_chart_position,
      depth_chart_order: p.depth_chart_order,
      number: p.number,
    };
  }
  saveSnapshot('sleeper_players.json', slim, {
    source: 'Sleeper API',
    url: PLAYERS_URL,
    kind: 'player_metadata',
    detail: `${Object.keys(slim).length} offense/K/DEF players (slimmed from ${count})`,
    ...got.validators,
  });
  return { players: Object.keys(slim).length };
}

// Deliberately unconditional: this response is well under a kilobyte and it
// decides the pipeline's mode and stats year, so it must never be served
// from a stale cache to save nothing.
export async function ingestSleeperState() {
  const state = await fetchJson(STATE_URL);
  saveSnapshot('sleeper_state.json', state, {
    source: 'Sleeper API',
    url: STATE_URL,
    kind: 'season_state',
  });
  return state;
}
