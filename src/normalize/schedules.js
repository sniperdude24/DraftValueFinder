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

// Bye weeks, straight from the fixture list: a team's bye is the week it has
// no game. This is the authoritative answer to a question the app previously
// took from FantasyPros and FFC — two market sources that can disagree with
// each other, and did have a conflict record for exactly that reason.
//
// ONLY ANSWERS WHEN EXACTLY ONE WEEK IS MISSING. A schedule published
// mid-season, or one this function is handed for a season that has not been
// released, leaves several gaps; picking one of them would be a guess dressed
// as a fact, and worse than deferring to the market value.
export function byeWeeks(rows, season) {
  const played = new Map();
  let maxWeek = 0;
  for (const r of rows ?? []) {
    if (Number(r.season) !== Number(season)) continue;
    if (r.game_type !== 'REG') continue;
    const week = Number(r.week);
    if (!Number.isFinite(week)) continue;
    if (week > maxWeek) maxWeek = week;
    for (const t of [normTeam(r.home_team), normTeam(r.away_team)]) {
      if (!t) continue;
      if (!played.has(t)) played.set(t, new Set());
      played.get(t).add(week);
    }
  }

  const byes = new Map();
  for (const [team, weeks] of played) {
    const missing = [];
    for (let w = 1; w <= maxWeek; w++) if (!weeks.has(w)) missing.push(w);
    if (missing.length === 1) byes.set(team, missing[0]);
  }
  return byes;
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
