// Game results, keyed by nflverse `game_id`.
//
// The weekly stats file and the schedules file share a primary key
// (`2025_17_DAL_WAS`), so a player's game row resolves to its final score by
// exact lookup. That matters more than it sounds: every other cross-source
// join in this app had to be defended against name and abbreviation drift,
// and this one has nothing to drift.
//
// Team codes still go through `normTeam` on the way in. The schedules file
// writes the Rams as "LA" — the same abbreviation that silently rendered an
// empty LAR panel when the play-by-play source was added. Normalizing at the
// boundary is what stops that recurring.
import { normTeam } from './names.js';

export function indexSchedule(rows) {
  const index = new Map();
  for (const r of rows ?? []) {
    if (!r.game_id) continue;
    index.set(r.game_id, {
      season: Number(r.season),
      week: Number(r.week),
      game_type: r.game_type,
      home: normTeam(r.home_team),
      away: normTeam(r.away_team),
      home_score: r.home_score === '' || r.home_score == null ? null : Number(r.home_score),
      away_score: r.away_score === '' || r.away_score == null ? null : Number(r.away_score),
    });
  }
  return index;
}

// Resolve one game from one team's point of view.
//
// Returns null — never a 0-0 game — when the id is unknown or the game has no
// final score yet. A scheduled-but-unplayed game and a genuine shutout are
// different facts, and the UI renders the first as blank and the second as 0.
export function resultFor(index, gameId, team) {
  const g = index?.get?.(gameId);
  if (!g) return null;
  if (g.home_score == null || g.away_score == null) return null;

  const me = normTeam(team);
  const atHome = g.home === me;
  // A game the player's team is not in means the join went wrong somewhere.
  // Reporting nothing is right; reporting the home side's result would be a
  // confident lie.
  if (!atHome && g.away !== me) return null;

  const team_score = atHome ? g.home_score : g.away_score;
  const opp_score = atHome ? g.away_score : g.home_score;
  return {
    at: !atHome,                                   // true = away game
    opponent: atHome ? g.away : g.home,
    outcome: team_score > opp_score ? 'W' : team_score < opp_score ? 'L' : 'T',
    team_score,
    opp_score,
  };
}
