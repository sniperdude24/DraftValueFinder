// Fantasy scoring — turns a game's component stats into points under a
// configurable, per-position rule set. (Not to be confused with score.js,
// which computes the AI rank.)
//
// WHY THIS EXISTS: the app previously carried one number, nflverse's
// `fantasy_points_ppr`, which meant scoring could never be adjusted. It also
// meant we were trusting a black box. Before building on these rules they
// were checked against that black box: computing PPR from the components
// below reproduces nflverse's own value for **all 18,539 regular-season
// player-weeks of 2025, exactly**. Custom rule sets are the same arithmetic
// with different coefficients, so they inherit that footing.
//
// THREE THINGS REAL LEAGUES NEED THAT A SINGLE FLAT MULTIPLIER CANNOT EXPRESS
//
//  1. POINTS PER UNIT. Leagues write "1 point per 20 passing yards", not
//     "0.05 points per yard". Storing the pair keeps the user's own numbers
//     intact instead of round-tripping them through a decimal that no longer
//     resembles what they typed.
//
//  2. PER-POSITION RULES. The same category is worth different amounts at
//     different positions — a rush attempt can pay 0.1 to a running back and
//     nothing to a quarterback, and a completion bonus applies only to
//     passers. One global table cannot say that.
//
//  3. THRESHOLDS. "10 points for a 100-yard rushing game" is not a rate at
//     all — it pays once when a line crosses a mark, and a 195-yard game pays
//     it once, not twice. Rules therefore come in two KINDS, and the stored
//     shape stays a plain pair either way:
//
//        rate      [a, b]  →  a points for every b of the stat
//        milestone [a, b]  →  a points once, when the stat reaches b
//
//     The threshold lives in the rule rather than the category so a league
//     with a 150-yard bonus can say so, for the same reason per-unit is
//     editable. See `scoreGame`, and read the note on `scoreAverages` before
//     assuming milestones behave like everything else.
//
// Reaching zero mismatches against nflverse required one correction worth
// remembering: `fumbles_lost_total` counts special-teams muffs, which fantasy
// does not charge to the player. Only sack, rushing and receiving fumbles
// count — see `fumbles_lost` in normalize/build.js. Scoring must never read
// the raw total.

export const POSITIONS = ['QB', 'RB', 'WR', 'TE'];

// [label, shortForm, primaryFor, meta?] — `primaryFor` lists the positions a
// league settings screen normally shows the category under.
//
// A rule key is the game-row field it reads, EXCEPT for milestones: those name
// the bonus ("100+ yard rushing game") and carry the field they measure in
// `meta.field`, because two different rules can read the same stat. That is
// why CATEGORY_KEYS and SCORING_FIELDS below are two different lists — the
// first is what rules are keyed by, the second is what the game row supplies.
//
// EVERY position can score EVERY category. That is not pedantry: receivers
// throw touchdowns on trick plays, quarterbacks catch passes, and a model
// that only scored a position's "natural" categories silently lost points on
// nine real 2025 game logs (DJ Moore and Breece Hall TD passes, a Drake Maye
// reception, a Chris Olave interception). The rare ones are simply hidden
// behind a disclosure in the editor rather than removed from the model.
export const CATEGORIES = {
  completions:           ['Pass completions', 'PaComp', ['QB']],
  attempts:              ['Pass attempts', 'PaAtt', ['QB']],
  passing_yards:         ['Passing yards', 'PaYd', ['QB']],
  passing_tds:           ['Passing TDs', 'PaTD', ['QB']],
  interceptions:         ['INT thrown', 'PaINT', ['QB']],
  carries:               ['Rush attempts', 'RuAtt', POSITIONS],
  rushing_yards:         ['Rushing yards', 'RuYd', POSITIONS],
  rushing_tds:           ['Rushing TDs', 'RuTD', POSITIONS],
  receptions:            ['Receptions', 'Rec', ['RB', 'WR', 'TE']],
  receiving_yards:       ['Receiving yards', 'ReYd', ['RB', 'WR', 'TE']],
  receiving_tds:         ['Receiving TDs', 'ReTD', ['RB', 'WR', 'TE']],
  two_point_conversions: ['2-point conversions', '2PT', POSITIONS],
  fumbles_lost:          ['Fumbles lost', 'FL', POSITIONS],
  special_teams_tds:     ['Special-teams TDs', 'STTD', POSITIONS],

  // ---- long-play bonuses ----
  // The weekly file counts plays of 40+ yards; the TDs of 40+ yards are
  // derived from play-by-play (see ingest/sources/nflversePbp.js), because
  // nflverse publishes the former and not the latter. Both are BONUSES —
  // additive on top of the touchdown's ordinary points, as a league settings
  // screen treats them.
  passing_40:            ['Completions of 40+ yards', 'Pa40', ['QB']],
  passing_40_tds:        ['Passing TDs of 40+ yards', 'Pa40TD', ['QB']],
  rushing_40:            ['Rushes of 40+ yards', 'Ru40', POSITIONS],
  rushing_40_tds:        ['Rushing TDs of 40+ yards', 'Ru40TD', POSITIONS],
  receiving_40:          ['Receptions of 40+ yards', 'Re40', ['RB', 'WR', 'TE']],
  receiving_40_tds:      ['Receiving TDs of 40+ yards', 'Re40TD', ['RB', 'WR', 'TE']],

  // ---- game milestones (threshold rules, not rates) ----
  passing_300_game:      ['300+ yard passing game', 'Pa300', ['QB'],
                          { kind: 'milestone', field: 'passing_yards', threshold: 300 }],
  rushing_100_game:      ['100+ yard rushing game', 'Ru100', POSITIONS,
                          { kind: 'milestone', field: 'rushing_yards', threshold: 100 }],
  receiving_100_game:    ['100+ yard receiving game', 'Re100', ['RB', 'WR', 'TE'],
                          { kind: 'milestone', field: 'receiving_yards', threshold: 100 }],
};

// What rules are keyed by.
export const CATEGORY_KEYS = Object.keys(CATEGORIES);

export const metaFor = key => CATEGORIES[key]?.[3] ?? null;
export const isMilestone = key => metaFor(key)?.kind === 'milestone';
// The game-row field a category reads. Same as the key for everything except
// milestones, which name a bonus rather than a stat.
export const fieldFor = key => metaFor(key)?.field ?? key;

// Every DISTINCT game-row field any rule can read. normalize/build.js stores
// per-game averages of these on the prior-season baseline, and the roster grid
// builds its columns from them — neither wants the milestone keys, which are
// not fields and would be undefined on every game row.
export const SCORING_FIELDS = [...new Set(CATEGORY_KEYS.map(fieldFor))];

// All categories apply everywhere; `primary` is only about editor layout.
export const categoriesFor = () => CATEGORY_KEYS;
export const primaryCategoriesFor = position =>
  Object.entries(CATEGORIES).filter(([, [, , on]]) => on.includes(position)).map(([k]) => k);
export const rareCategoriesFor = position =>
  CATEGORY_KEYS.filter(k => !CATEGORIES[k][2].includes(position));

// A rule is [points, perUnit]: `points` awarded for every `perUnit` of the
// stat. [1, 20] is a point per 20 yards; [6, 1] is six points a touchdown.
const R = (points, perUnit = 1) => [points, perUnit];

// Standard scoring, expressed the way a league settings page writes it —
// "1 point per 25 passing yards", not "0.04 points per yard".
const STANDARD_TABLE = receptionPts => ({
  completions: R(0),
  attempts: R(0),
  passing_yards: R(1, 25),
  passing_tds: R(4),
  interceptions: R(-2),
  carries: R(0),
  rushing_yards: R(1, 10),
  rushing_tds: R(6),
  receptions: R(receptionPts),
  receiving_yards: R(1, 10),
  receiving_tds: R(6),
  two_point_conversions: R(2),
  fumbles_lost: R(-2),
  special_teams_tds: R(6),
  // No stock format pays long-play or milestone bonuses, so they are worth
  // nothing until a league says otherwise. This is also what keeps the PPR
  // preset reproducing nflverse exactly after these categories were added.
  passing_40: R(0),
  passing_40_tds: R(0),
  rushing_40: R(0),
  rushing_40_tds: R(0),
  receiving_40: R(0),
  receiving_40_tds: R(0),
  // For a milestone the second number is the threshold, not a divisor. It
  // carries the conventional mark so the editor opens on something meaningful
  // even though zero points means it pays nothing yet.
  passing_300_game: R(0, 300),
  rushing_100_game: R(0, 100),
  receiving_100_game: R(0, 100),
});

// The stock formats apply the same table at every position — which is also
// what nflverse does, and why the PPR preset reproduces its numbers exactly.
// Per-position differences appear once a league customizes.
const skillPreset = receptionPts => Object.fromEntries(
  POSITIONS.map(pos => [pos, STANDARD_TABLE(receptionPts)]));

// The three common formats differ only in what a catch is worth, which is
// worth expressing rather than triplicating a table that could drift.
export const PRESETS = {
  ppr: skillPreset(1),
  half_ppr: skillPreset(0.5),
  standard: skillPreset(0),
};

export const DEFAULT_PRESET = 'ppr';
export const DEFAULT_RULES = PRESETS[DEFAULT_PRESET];

const clone = rules => Object.fromEntries(
  Object.entries(rules).map(([pos, cats]) => [pos, Object.fromEntries(
    Object.entries(cats).map(([k, v]) => [k, [...v]]))]));

// Accept a rule value in either shape: [pts, per], or a bare number from the
// pre-per-unit format, which meant points per single unit.
function normalizeRule(v) {
  if (Array.isArray(v)) {
    const pts = Number(v[0]), per = Number(v[1] ?? 1);
    return [Number.isFinite(pts) ? pts : 0, Number.isFinite(per) && per !== 0 ? per : 1];
  }
  const n = Number(v);
  return [Number.isFinite(n) ? n : 0, 1];
}

// Fill in any category a stored rule set is missing, so a rule added in a
// later version scores at its default rather than silently at zero.
export function normalizeRules(rules) {
  const out = {};
  for (const pos of POSITIONS) {
    const src = rules?.[pos] ?? {};
    out[pos] = {};
    for (const key of categoriesFor(pos)) {
      out[pos][key] = key in src ? normalizeRule(src[key]) : [...(DEFAULT_RULES[pos][key] ?? R(0))];
    }
  }
  return out;
}

// A rule set stored before scoring was per-position: one flat table that
// applied to everyone. Spread it across the positions rather than dropping
// the user's settings on upgrade.
export function migrateFlatRules(flat) {
  if (!flat || Array.isArray(flat)) return null;
  if (POSITIONS.some(p => p in flat)) return normalizeRules(flat);   // already per-position
  const spread = {};
  for (const pos of POSITIONS) {
    spread[pos] = {};
    for (const key of categoriesFor(pos)) {
      if (key in flat) spread[pos][key] = normalizeRule(flat[key]);
    }
  }
  return normalizeRules(spread);
}

export function rulesFor(scoring) {
  if (!scoring) return DEFAULT_RULES;
  if (scoring.preset && scoring.preset !== 'custom') {
    return PRESETS[scoring.preset] ?? DEFAULT_RULES;
  }
  return migrateFlatRules(scoring.rules) ?? DEFAULT_RULES;
}

// Rate rules are compared by RATE, so [1,25] and [0.04,1] are the same rule
// written two ways. A milestone has no rate — points over a threshold is not a
// meaningful quantity — so it compares by points, with the threshold mattering
// only when the bonus is actually worth something.
function sameRule(key, a, b) {
  const [ap, ab] = normalizeRule(a);
  const [bp, bb] = normalizeRule(b);
  if (isMilestone(key)) return ap === bp && (ap === 0 || ab === bb);
  return ap / ab === bp / bb;
}

export function isPresetEqual(rules, presetName) {
  const preset = PRESETS[presetName];
  if (!preset) return false;
  return POSITIONS.every(pos =>
    categoriesFor(pos).every(key => sameRule(key, rules?.[pos]?.[key] ?? [0, 1], preset[pos][key])));
}

// Name the preset a rule set corresponds to, or 'custom' when it matches none.
export function describeRules(rules) {
  for (const name of Object.keys(PRESETS)) if (isPresetEqual(rules, name)) return name;
  return 'custom';
}

// Copy one position's rules onto another — the "same scoring as RB?" toggle.
export function copyPosition(rules, from, to) {
  const next = clone(normalizeRules(rules));
  for (const key of categoriesFor(to)) {
    if (key in next[from]) next[to][key] = [...next[from][key]];
  }
  return next;
}

// Score one game under a POSITION's rules. A component the source did not
// supply contributes nothing, but a row carrying no scoring components at
// all yields null rather than a confident 0 — the same "undefined, not zero"
// discipline the rest of src/analyze follows, so the UI can print "—".
export function scoreGame(game, positionRules = DEFAULT_RULES.RB, { milestones = true } = {}) {
  if (!game || !positionRules) return null;
  let total = 0, seen = false;
  for (const [key, rule] of Object.entries(positionRules)) {
    const milestone = isMilestone(key);
    if (milestone && !milestones) continue;
    const v = game[fieldFor(key)];
    if (v == null) continue;
    // A milestone reads a field another rule also reads, so it must not be
    // what makes a row count as having data — otherwise a row of nothing but
    // milestone rules would score 0 instead of null.
    if (!milestone) seen = true;
    const [points, bound] = normalizeRule(rule);
    // Pays once at the mark. A 195-yard game is one 100-yard game, not two.
    if (milestone) total += v >= bound ? points : 0;
    else total += (v / bound) * points;
  }
  if (!seen) return null;
  // Fantasy points are conventionally reported to two decimals; rounding
  // here keeps per-unit division from surfacing float dust.
  return Math.round(total * 100) / 100;
}

// Score a whole player universe in place: every game row gets
// `fantasy_points`, and a prior-season baseline gets `points` re-scored from
// its stored component averages.
//
// This is the single pass that makes a scoring change flow through the whole
// app — trends, the spike test, the AI rank, team pages and the chat all read
// `fantasy_points`. It lives here rather than inline in the server so the
// per-position lookup is testable: scoring every player under one position's
// rules is a silent, plausible-looking bug that no UI would reveal.
export function scorePlayers(players, rules) {
  const byPosition = normalizeRules(rules);
  for (const p of players) {
    // Positions with no rule set (K, DST) simply score nothing.
    const posRules = byPosition[p.position] ?? null;
    for (const g of p.games ?? []) g.fantasy_points = scoreGame(g, posRules);
    // Averages, not a game — so this must go through scoreAverages, which
    // leaves milestone bonuses out rather than testing a threshold against a
    // mean. See the note there.
    if (p.baseline?.components) p.baseline.points = scoreAverages(p.baseline.components, posRules);
    // A projection is an EXPECTATION, not a game — so it goes through
    // scoreAverages too. Paying a 100-yard-game bonus on a projected 105 yards
    // is the same error as paying it on a season average: the projection says
    // nothing about how often the mark is actually crossed.
    //
    // The result is this app's arithmetic on Sleeper's components, and every
    // surface that shows it says so. `pts_ppr` beside it stays Sleeper's own.
    if (p.projection?.components) p.projection.points = scoreAverages(p.projection.components, posRules);
  }
  return byPosition;
}

// RATE scoring is linear in its components, so the score of the per-game
// averages equals the average of the per-game scores. That is what lets a
// player's prior-season baseline be re-scored from stored averages alone,
// without keeping every baseline game row on the record.
//
// MILESTONES ARE NOT LINEAR, and no average can recover them. A back averaging
// 95 rushing yards may well have had six 100-yard games; scoring his average
// pays the bonus zero times, and a back averaging 105 would be paid on every
// game including the ones he was hurt in. Both answers are wrong, and neither
// is visible in the output.
//
// So the baseline path skips milestone rules and the UI says the prior-season
// line excludes them. Live game rows are unaffected — they score exactly — and
// the roster grid's multi-week ranges sum PER-GAME scores rather than scoring
// summed stats, so milestones come out right there with no special handling.
export const scoreAverages = (averages, positionRules) =>
  scoreGame(averages, positionRules, { milestones: false });
