import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  statLineFor, projectionFor, weeksAvailable, defaultRange,
  STAT_FIELDS, COLUMN_GROUPS, describeField,
} from '../src/analyze/rosterTable.js';
import { CATEGORIES } from '../src/analyze/fantasyPoints.js';

const wr = {
  position: 'WR',
  games: [
    { week: 1, targets: 8, receptions: 5, receiving_yards: 60, receiving_tds: 1, receiving_40: 0, fantasy_points: 17 },
    { week: 2, targets: 4, receptions: 3, receiving_yards: 22, receiving_tds: 0, receiving_40: 0, fantasy_points: 5.2 },
    // week 3 missing — bye or inactive
    { week: 4, targets: 11, receptions: 9, receiving_yards: 140, receiving_tds: 2, receiving_40: 1, fantasy_points: 35 },
    { week: 5, targets: 6, receptions: 4, receiving_yards: 51, receiving_tds: 0, receiving_40: 0, fantasy_points: 9.1 },
    { week: 6, targets: 7, receptions: 6, receiving_yards: 71, receiving_tds: 1, receiving_40: 0, fantasy_points: 19.1 },
  ],
  baseline: { season: 2024, games: 16, points: 12.4, components: { receptions: 4.5, receiving_yards: 58.2, receiving_tds: 0.4 } },
};

test('a single week returns that week\'s row, not an aggregate', () => {
  const line = statLineFor(wr, 'week', { week: 4 });
  assert.equal(line.basis, 'game');
  assert.equal(line.games, 1);
  assert.equal(line.stats.receptions, 9);
  assert.equal(line.stats.receiving_yards, 140);
  assert.equal(line.points, 35);
});

test('a week the player has no row for is null, never zeros', () => {
  // A bye, an inactive and a healthy scratch are not 0-target games. Zeros
  // here would put fabricated shutouts on the page.
  assert.equal(statLineFor(wr, 'week', { week: 3 }), null);
  assert.equal(statLineFor(wr, 'week', { week: 17 }), null);
  assert.equal(statLineFor({ position: 'WR', games: [] }, 'week', { week: 1 }), null);
});

test('a multi-week range sums, it does not average', () => {
  const season = statLineFor(wr, 'season');
  assert.equal(season.basis, 'total');
  assert.equal(season.games, 5);
  assert.equal(season.stats.receptions, 27);         // 5+3+9+4+6
  assert.equal(season.stats.receiving_yards, 344);
  assert.equal(season.stats.receiving_tds, 4);
  assert.equal(season.points, 85.4);
});

test('last 4 covers the last four games PLAYED, skipping the missing week', () => {
  const last4 = statLineFor(wr, 'last4');
  assert.deepEqual(last4.weeks, [2, 4, 5, 6], 'the bye does not consume a slot');
  assert.equal(last4.stats.receptions, 22);          // 3+9+4+6
  assert.equal(last4.games, 4);
});

test('a field no row supplied stays null rather than becoming zero', () => {
  const noPassing = statLineFor(wr, 'season');
  assert.equal(noPassing.stats.passing_yards, null, 'a receiver has no passing rows at all');
  assert.equal(noPassing.stats.receiving_40, 1, 'but an explicit zero still sums');
});

test('the prior season reports per-game averages and labels its basis', () => {
  // Only averages are stored for the baseline season, so presenting them as
  // totals would understate the player by a factor of the games played.
  const prior = statLineFor(wr, 'prior');
  assert.equal(prior.basis, 'average');
  assert.equal(prior.stats.receptions, 4.5);
  assert.equal(prior.points, 12.4);
  assert.equal(prior.season, 2024);
  assert.equal(prior.games, 16);
});

test('a player with no baseline has no prior-season line', () => {
  assert.equal(statLineFor({ position: 'WR', games: wr.games }, 'prior'), null);
});

test('a player with no games at all yields null for every summed range', () => {
  const empty = { position: 'RB', games: [] };
  assert.equal(statLineFor(empty, 'season'), null);
  assert.equal(statLineFor(empty, 'last4'), null);
});

// ---- projections ----

test('a projection shows only on the exact week it was published for', () => {
  const p = { ...wr, projection: { week: 6, pts_ppr: 14.2 } };
  assert.equal(projectionFor(p, 'week', { week: 6 }).pts_ppr, 14.2);
  assert.equal(projectionFor(p, 'week', { week: 5 }), null, 'not carried to another week');
  assert.equal(projectionFor(p, 'season'), null, 'never summed across a range');
  assert.equal(projectionFor(p, 'last4'), null);
  assert.equal(projectionFor(wr, 'week', { week: 6 }), null, 'no projection, no number');
});

// ---- column spec ----

test('every column maps to a real game-row field with a full name', () => {
  for (const key of STAT_FIELDS) {
    assert.ok(describeField(key) !== key, `${key} needs a readable name`);
  }
  // Scoring categories take their name from the scoring editor, so the grid
  // and the editor cannot drift apart on what a field is called.
  assert.equal(describeField('receiving_yards'), CATEGORIES.receiving_yards[0]);
});

test('column labels are short because the group header carries the context', () => {
  const yds = COLUMN_GROUPS.flatMap(g => g.columns).filter(([, label]) => label === 'Yds');
  assert.equal(yds.length, 3, 'passing, rushing and receiving all show "Yds"');
  assert.deepEqual(yds.map(([k]) => k), ['passing_yards', 'rushing_yards', 'receiving_yards']);
});

// ---- week stepper / defaults ----

test('the week stepper only offers weeks the roster has data for', () => {
  assert.deepEqual(weeksAvailable([wr]), [1, 2, 4, 5, 6]);
  assert.deepEqual(weeksAvailable([]), []);
});

test('draft mode opens on the season, not an empty current week', () => {
  // Preseason, every weekly column would be blank. The grid must never open
  // on a table with nothing in it.
  assert.equal(defaultRange('draft', [1, 2, 3]), 'season');
  assert.equal(defaultRange('season', [1, 2, 3]), 'week');
  assert.equal(defaultRange('season', []), 'season', 'season mode before week 1 has no weeks yet');
});
