// League rosters — who in the league actually holds each player.
//
// The app used to know only "taken by somebody". Knowing WHICH team holds a
// player is what makes the rest of the analysis usable in-season: whether the
// back you want is stashed on a team already deep at the position, whether a
// vacated role is even available, who you would have to trade with.
//
// Two rules carried over from the rest of the codebase:
//  - Roster problems are WARNINGS, never blocks. The app does not refuse a
//    roster it thinks is wrong; it says what it noticed.
//  - Names that cannot be matched are SURFACED, never silently dropped —
//    the same rule src/yahoo/sync.js applies to unmatched picks.
import { LEAGUE, rosterSummary } from './roster.js';
import { STAT_FIELDS } from './rosterTable.js';
import { nameKey, normPosition } from '../normalize/names.js';
import { UNKNOWN_OWNER } from '../store/state.js';

export { UNKNOWN_OWNER };

export function rosterFor(players, state, teamId) {
  const owners = state.owners ?? {};
  const order = new Map((state.picks ?? []).map((id, i) => [id, i]));
  return players
    .filter(p => owners[p.id] === teamId)
    .sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
}

// Roster observations. `over_limit` counts against LEAGUE.rounds (15), which
// is a roster cap rather than a draft-only notion.
function teamWarnings(roster) {
  const warnings = [];
  if (roster.length > LEAGUE.rounds) {
    warnings.push(`${roster.length} players — ${roster.length - LEAGUE.rounds} over the ${LEAGUE.rounds}-man limit`);
  }
  const summary = rosterSummary(roster);
  for (const c of summary.byeConflicts) {
    warnings.push(`${c.players.length} players share the week-${c.week} bye`);
  }
  return { warnings, summary };
}

export function leagueView(players, state) {
  const teams = (state.league?.teams ?? []).map(t => {
    const roster = rosterFor(players, state, t.id);
    const { warnings, summary } = teamWarnings(roster);
    return {
      id: t.id,
      name: t.name,
      mine: !!t.mine,
      count: roster.length,
      players: roster.map(p => rosterRow(p, state)),
      needs: summary.needs,
      counts: summary.counts,
      warnings,
    };
  });

  // Players known to be taken but whose team was never recorded — the
  // residue of the old binary flag. Shown so they can be assigned, not
  // hidden and not guessed at.
  const unknown = rosterFor(players, state, UNKNOWN_OWNER).map(p => rosterRow(p, state));

  const ownedIds = new Set(Object.keys(state.owners ?? {}));
  return {
    teams,
    unknown_owner: unknown,
    free_agents: players.length - ownedIds.size,
    roster_limit: LEAGUE.rounds,
    team_count: teams.length,
  };
}

// Ten rosters' worth of full game logs would be a needlessly heavy response
// (150 players × ~17 weeks × 40 fields), so the log is slimmed to exactly what
// the roster grid draws. It is still the whole log rather than one week's
// worth: that is what lets the grid switch weeks and ranges without a round
// trip back to the server.
const GAME_FIELDS = ['week', 'opponent', 'game_result', 'fantasy_points', ...STAT_FIELDS];

function slimGame(g) {
  const out = {};
  for (const f of GAME_FIELDS) if (g[f] !== undefined) out[f] = g[f];
  return out;
}

function rosterRow(p, state) {
  const idx = (state.picks ?? []).indexOf(p.id);
  return {
    id: p.id, name: p.name, position: p.position, team: p.team, bye: p.bye,
    injury_status: p.meta?.injury_status ?? null,
    sleeper_id: p.meta?.sleeper_id ?? null,
    pick_number: idx === -1 ? null : idx + 1,
    projection: p.projection ?? null,
    games: (p.games ?? []).map(slimGame),
    // Components only — the grid re-scores nothing, it just reads the
    // averages the build already stored for the baseline season.
    baseline: p.baseline
      ? { season: p.baseline.season, games: p.baseline.games, points: p.baseline.points, components: p.baseline.components }
      : null,
  };
}

// ---- bulk paste ----

// Accepts newline- or comma-separated names, tolerating the shapes people
// actually paste: "Bijan Robinson", "Bijan Robinson RB ATL", "1. Bijan
// Robinson", "Bijan Robinson (ATL - RB)".
export function parseNameList(text) {
  return String(text ?? '')
    .split(/[\n,;]+/)
    .map(s => s
      .replace(/^\s*\d+[.)]?\s*/, '')          // leading pick number
      .replace(/\((?:[^)]*)\)/g, ' ')          // parenthetical team/pos
      .replace(/\b(QB|RB|WR|TE|K|DST|DEF|D\/ST)\b/gi, ' ')
      .trim())
    .filter(Boolean);
}

// Resolve pasted names against the player universe. Ambiguous names (two
// players sharing a name key) are reported separately rather than resolved
// by guesswork — picking one silently is how a roster ends up quietly wrong.
export function resolveNames(text, players, { position = null } = {}) {
  const byKey = new Map();
  for (const p of players) {
    if (position && normPosition(p.position) !== normPosition(position)) continue;
    const k = nameKey(p.name);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(p);
  }

  const matched = [], unmatched = [], ambiguous = [];
  const seen = new Set();
  for (const raw of parseNameList(text)) {
    const hits = byKey.get(nameKey(raw)) ?? [];
    if (hits.length === 1) {
      const p = hits[0];
      if (seen.has(p.id)) continue;      // the same player listed twice
      seen.add(p.id);
      matched.push({ input: raw, id: p.id, name: p.name, position: p.position, team: p.team });
    } else if (hits.length > 1) {
      ambiguous.push({ input: raw, candidates: hits.map(p => ({ id: p.id, name: p.name, position: p.position, team: p.team })) });
    } else {
      unmatched.push(raw);
    }
  }
  return { matched, unmatched, ambiguous };
}
