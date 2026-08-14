// The roster stat grid — a league-settings-shaped view of a team's players.
//
// This is the layout every fantasy site uses for a roster: starters then
// bench, one row per player, stat columns grouped by phase. It exists here as
// a pure module (rather than inline in the view) because the aggregation has
// three rules that are easy to get wrong and impossible to see wrong:
//
//  1. A MULTI-WEEK RANGE SUMS, it does not average. "Last 4 weeks" means the
//     four-week totals, the way a scoring page reports them.
//
//  2. A WEEK THE PLAYER HAS NO ROW FOR IS NULL, NOT ZERO. A bye, an inactive
//     and a healthy scratch are not 0-target games. Rendering them as zeros
//     would put fabricated shutouts on the page and quietly drag any average
//     computed downstream.
//
//  3. THE PRIOR SEASON IS AVERAGES, NOT TOTALS. Only per-game averages are
//     kept for the baseline season (see `baselineFrom` in normalize/build.js),
//     so that range reports averages and says so in `basis`. Showing them
//     under the same header as season totals would understate them by a
//     factor of the games played.
//
// Fan Pts here is `fantasy_points` — scored under the user's own per-position
// rules, which is the whole point of the grid. Projected points are external
// (Sleeper) and exist for one week only; see `projectionFor`.
import { CATEGORIES } from './fantasyPoints.js';

// Column labels are deliberately short — the group header above them supplies
// the context, so "Yds" appears three times and means three different things.
// The full name comes from CATEGORIES where the field is a scoring category,
// so the editor and the grid cannot drift apart on what a field is called.
const EXTRA_LABELS = {
  targets: 'Targets',
};

export const COLUMN_GROUPS = [
  { group: 'Passing', columns: [
    ['completions', 'Comp'], ['passing_yards', 'Yds'], ['passing_tds', 'TD'],
    ['interceptions', 'Int'], ['passing_40', '40 Yd Cmp'], ['passing_40_tds', '40 Yd TD'],
  ] },
  { group: 'Rushing', columns: [
    ['carries', 'Att'], ['rushing_yards', 'Yds'], ['rushing_tds', 'TD'],
    ['rushing_40', '40 Yd Att'], ['rushing_40_tds', '40 Yd TD'],
  ] },
  { group: 'Receiving', columns: [
    ['targets', 'Tgt'], ['receptions', 'Rec'], ['receiving_yards', 'Yds'],
    ['receiving_tds', 'TD'], ['receiving_40', '40 Yd Rec'], ['receiving_40_tds', '40 Yd TD'],
  ] },
  { group: 'Ret', columns: [['special_teams_tds', 'TD']] },
  { group: 'Misc', columns: [['two_point_conversions', '2PT'], ['fumbles_lost', 'FL']] },
];

export const STAT_FIELDS = COLUMN_GROUPS.flatMap(g => g.columns.map(([k]) => k));

export const describeField = key => CATEGORIES[key]?.[0] ?? EXTRA_LABELS[key] ?? key;

// Columns a fantasy roster page normally carries that no source here can
// fill. Named rather than rendered as a wall of dashes — see the note this
// feeds in the UI.
export const UNAVAILABLE_COLUMNS = [
  ['Pick Six', 'a pick-six is scored by the returning defense, so it is not on the passer\'s row in the weekly player file'],
];

export const RANGES = ['week', 'last4', 'season', 'prior'];
const RECENT_GAMES = 4;

// Sum a field across rows. A field no row supplied stays null: "the source
// did not say" and "the player did none" are different, and the rest of
// src/analyze keeps them apart too.
function sumField(rows, field) {
  let total = 0, seen = false;
  for (const r of rows) {
    const v = r?.[field];
    if (v == null) continue;
    seen = true;
    total += v;
  }
  return seen ? Math.round(total * 100) / 100 : null;
}

function totals(rows) {
  const stats = {};
  for (const f of STAT_FIELDS) stats[f] = sumField(rows, f);
  return stats;
}

/**
 * One player's line for one range.
 *
 * @returns {null|{range, basis, games, weeks, stats, points}}
 *   `basis` is 'game' (a single week), 'total' (summed weeks) or 'average'
 *   (per-game, prior season). null means there is nothing to show — which the
 *   caller must render as blank, never as zeros.
 */
export function statLineFor(player, range, { week = null } = {}) {
  const games = player?.games ?? [];

  if (range === 'prior') {
    const c = player?.baseline?.components;
    if (!c) return null;
    const stats = {};
    for (const f of STAT_FIELDS) stats[f] = c[f] ?? null;
    return {
      range, basis: 'average', games: player.baseline.games ?? null,
      weeks: [], stats, points: player.baseline.points ?? null,
      season: player.baseline.season ?? null,
    };
  }

  if (range === 'week') {
    const g = games.find(x => x.week === week);
    if (!g) return null;               // did not play — not a zero line
    const stats = {};
    for (const f of STAT_FIELDS) stats[f] = g[f] ?? null;
    return { range, basis: 'game', games: 1, weeks: [g.week], stats, points: g.fantasy_points ?? null, game: g };
  }

  // Both remaining ranges are sums over games PLAYED, matching the "last 3
  // games played" convention the trend engine already uses — a bye should not
  // consume one of the four slots.
  const rows = range === 'last4' ? games.slice(-RECENT_GAMES) : games;
  if (!rows.length) return null;
  return {
    range, basis: 'total', games: rows.length, weeks: rows.map(r => r.week),
    stats: totals(rows), points: sumField(rows, 'fantasy_points'),
  };
}

// Projected points are an external Sleeper number published for ONE week.
// They are returned only when that exact week is what the grid is showing —
// never summed across a range, never carried to a different week. Anything
// else would put a projection under a column heading it does not answer.
export function projectionFor(player, range, { week = null } = {}) {
  const proj = player?.projection;
  if (!proj || range !== 'week') return null;
  return proj.week === week ? proj : null;
}

// Weeks any player on the roster actually has a row for. The week stepper
// walks this rather than 1..18, so it cannot land on an empty grid.
export function weeksAvailable(players) {
  const weeks = new Set();
  for (const p of players ?? []) for (const g of p.games ?? []) if (g.week != null) weeks.add(g.week);
  return [...weeks].sort((a, b) => a - b);
}

// Open on a range that has data. In draft mode the "current week" is the
// preseason and every weekly column would be blank, so the full stats season
// is the honest default.
export function defaultRange(mode, weeks = []) {
  return mode === 'season' && weeks.length ? 'week' : 'season';
}
