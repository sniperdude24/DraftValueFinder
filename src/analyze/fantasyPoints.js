// Fantasy scoring — turns a game's component stats into points under a
// configurable rule set. (Not to be confused with score.js, which computes
// the AI rank.)
//
// WHY THIS EXISTS: the app previously carried one number, nflverse's
// `fantasy_points_ppr`, which meant scoring could never be adjusted. It also
// meant we were trusting a black box. Before building on these rules they
// were checked against that black box: computing PPR from the components
// below reproduces nflverse's own value for **all 18,539 regular-season
// player-weeks of 2025, exactly**. The custom rule sets are the same
// arithmetic with different coefficients, so they inherit that footing.
//
// Reaching zero mismatches required one correction worth remembering. The
// first attempt was off by exactly -2.00 on 36 rows, every one a return
// specialist: `fumbles_lost_total` counts special-teams muffs, which fantasy
// does not charge to the player. Only sack, rushing and receiving fumbles
// count — see `fumbles_lost` in normalize/build.js, which now stores exactly
// that. Scoring must never read the raw total.

// Every rule is points-per-unit of the named component. Yardage rules are
// expressed per yard (0.04 = one point per 25 yards) so the whole rule set
// is one flat multiply-and-sum with no special cases.
export const PPR_RULES = {
  passing_yards: 0.04,        // 1 per 25
  passing_tds: 4,
  interceptions: -2,
  rushing_yards: 0.1,         // 1 per 10
  rushing_tds: 6,
  receptions: 1,
  receiving_yards: 0.1,
  receiving_tds: 6,
  two_point_conversions: 2,
  fumbles_lost: -2,
  special_teams_tds: 6,
};

// The three formats differ only in what a catch is worth. Keeping them as
// overrides of one base makes that visible instead of triplicating a table
// that could drift apart.
export const PRESETS = {
  ppr: { ...PPR_RULES },
  half_ppr: { ...PPR_RULES, receptions: 0.5 },
  standard: { ...PPR_RULES, receptions: 0 },
};

export const DEFAULT_PRESET = 'ppr';
export const DEFAULT_RULES = PRESETS[DEFAULT_PRESET];

// Fields a game row must supply. `two_point_conversions` is the sum of the
// passing/rushing/receiving varieties — they are always worth the same, and
// no scoring system distinguishes them.
export const SCORING_FIELDS = Object.keys(PPR_RULES);

export function rulesFor(scoring) {
  if (!scoring) return DEFAULT_RULES;
  if (scoring.preset && scoring.preset !== 'custom') {
    return PRESETS[scoring.preset] ?? DEFAULT_RULES;
  }
  // A custom set is a full rule set; fall back per-field so a partial object
  // (or a rule added in a later version) can never silently score as zero.
  return { ...DEFAULT_RULES, ...(scoring.rules ?? {}) };
}

export function isPresetEqual(rules, presetName) {
  const preset = PRESETS[presetName];
  if (!preset) return false;
  return SCORING_FIELDS.every(f => (rules[f] ?? 0) === preset[f]);
}

// Name the preset a rule set corresponds to, or 'custom' when it matches none.
export function describeRules(rules) {
  for (const name of Object.keys(PRESETS)) if (isPresetEqual(rules, name)) return name;
  return 'custom';
}

// Score one game. A component the source did not supply contributes nothing,
// but a row carrying NO scoring components at all yields null rather than a
// confident 0 — the same "undefined, not zero" discipline the rest of
// src/analyze follows, so the UI can print "—".
export function scoreGame(game, rules = DEFAULT_RULES) {
  if (!game) return null;
  let total = 0, seen = false;
  for (const field of SCORING_FIELDS) {
    const v = game[field];
    if (v == null) continue;
    seen = true;
    total += v * (rules[field] ?? 0);
  }
  if (!seen) return null;
  // Fantasy points are conventionally reported to two decimals; rounding
  // here keeps 0.1-per-yard arithmetic from surfacing float dust.
  return Math.round(total * 100) / 100;
}

// Scoring is linear in its components, so the score of the per-game averages
// equals the average of the per-game scores. That is what lets a player's
// prior-season baseline be re-scored from stored averages alone, without
// keeping every baseline game row on the record.
export const scoreAverages = scoreGame;
