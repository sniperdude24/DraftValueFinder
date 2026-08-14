import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scoreGame, scoreAverages, scorePlayers, rulesFor, describeRules, normalizeRules,
  migrateFlatRules, copyPosition, PRESETS, POSITIONS, SCORING_FIELDS, CATEGORY_KEYS,
  primaryCategoriesFor, isMilestone, fieldFor,
} from '../src/analyze/fantasyPoints.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// An 8-catch, 100-yard, 1-TD receiving line.
const receivingGame = {
  receptions: 8, receiving_yards: 100, receiving_tds: 1,
  rushing_yards: 0, rushing_tds: 0, passing_yards: 0, passing_tds: 0,
  interceptions: 0, two_point_conversions: 0, fumbles_lost: 0, special_teams_tds: 0,
  completions: 0, attempts: 0, carries: 0,
};

test('PPR scores a receiving line the standard way', () => {
  assert.equal(scoreGame(receivingGame, PRESETS.ppr.WR), 24);   // 8 + 10 + 6
});

test('the stock presets differ only in what a catch is worth', () => {
  assert.equal(scoreGame(receivingGame, PRESETS.half_ppr.WR), 20);
  assert.equal(scoreGame(receivingGame, PRESETS.standard.WR), 16);
  for (const key of CATEGORY_KEYS) {
    if (key === 'receptions') continue;
    assert.deepEqual(PRESETS.half_ppr.WR[key], PRESETS.ppr.WR[key], key);
    assert.deepEqual(PRESETS.standard.WR[key], PRESETS.ppr.WR[key], key);
  }
});

// ---- points per unit ----

test('a rule is points per N units, not a flattened multiplier', () => {
  // "1 point per 20 yards" — the shape a league settings page uses.
  const rules = { passing_yards: [1, 20] };
  assert.equal(scoreGame({ passing_yards: 300 }, rules), 15);
  assert.equal(scoreGame({ passing_yards: 10 }, rules), 0.5, 'partial units count');
});

test('the same rate written two ways scores identically', () => {
  const perTwenty = { passing_yards: [1, 20] };
  const perYard = { passing_yards: [0.05, 1] };
  const g = { passing_yards: 317 };
  assert.equal(scoreGame(g, perTwenty), scoreGame(g, perYard));
});

test('a bare number is read as points per single unit', () => {
  // The pre-per-unit storage format must not silently become zero.
  assert.equal(scoreGame({ rushing_tds: 2 }, { rushing_tds: 6 }), 12);
});

// ---- per-position isolation ----

test('a completion bonus reaches quarterbacks only', () => {
  // David's league pays 1 point per completion. A running back who completes
  // a halfback-option pass must not be paid on the QB's rule.
  const rules = normalizeRules({
    QB: { completions: [1, 1] },
    RB: { completions: [0, 1] },
  });
  const line = { completions: 20, passing_yards: 0 };
  assert.equal(scoreGame(line, rules.QB), 20);
  assert.equal(scoreGame(line, rules.RB), 0);
});

test('a per-carry bonus can pay backs and nothing to passers', () => {
  const rules = normalizeRules({ QB: { carries: [0, 1] }, RB: { carries: [0.1, 1] } });
  const line = { carries: 20 };
  assert.equal(scoreGame(line, rules.RB), 2);
  assert.equal(scoreGame(line, rules.QB), 0);
});

test('every position can score every category', () => {
  // Receivers throw touchdowns on trick plays and quarterbacks catch passes.
  // Dropping non-native categories silently lost points on real game logs.
  for (const pos of POSITIONS) {
    for (const key of CATEGORY_KEYS) {
      assert.ok(PRESETS.ppr[pos][key], `${pos} must have a rule for ${key}`);
    }
  }
  const wrTdPass = { passing_tds: 1, passing_yards: 5 };
  assert.equal(scoreGame(wrTdPass, PRESETS.ppr.WR), 4.2, 'a receiver TD pass still scores');
});

test('rule keys and game-row fields are different lists once milestones exist', () => {
  // The trap: SCORING_FIELDS used to be Object.keys(CATEGORIES), which worked
  // only while every rule key WAS a game-row field. build.js averages
  // SCORING_FIELDS onto the baseline — feeding it milestone keys would store
  // undefined for a stat no game row has.
  assert.ok(CATEGORY_KEYS.includes('rushing_100_game'));
  assert.ok(!SCORING_FIELDS.includes('rushing_100_game'), 'not a game-row field');
  assert.ok(SCORING_FIELDS.includes('rushing_yards'), 'the field it reads is');
  assert.equal(fieldFor('rushing_100_game'), 'rushing_yards');
  assert.equal(fieldFor('rushing_yards'), 'rushing_yards', 'a rate rule is its own field');
  assert.ok(isMilestone('rushing_100_game') && !isMilestone('rushing_yards'));
  assert.equal(new Set(SCORING_FIELDS).size, SCORING_FIELDS.length, 'no duplicate fields');
});

test('primary categories are a layout hint, not a scoring restriction', () => {
  assert.ok(primaryCategoriesFor('QB').includes('completions'));
  assert.ok(!primaryCategoriesFor('WR').includes('completions'));
  // ...but the WR rule set still contains it, and still scores it.
  assert.ok(PRESETS.ppr.WR.completions);
});

// ---- scoring a whole universe ----

test('each player is scored under their own position\'s rules', () => {
  // The bug this guards: scoring everybody under one position's table looks
  // completely plausible in the UI — every number is populated, just wrong.
  const rules = normalizeRules({
    QB: { completions: [1, 1], carries: [0, 1] },
    RB: { completions: [0, 1], carries: [0.1, 1] },
  });
  const players = [
    { position: 'QB', games: [{ completions: 20, carries: 5 }] },
    { position: 'RB', games: [{ completions: 0, carries: 20 }] },
  ];
  scorePlayers(players, rules);
  assert.equal(players[0].games[0].fantasy_points, 20, 'QB paid for completions, not carries');
  assert.equal(players[1].games[0].fantasy_points, 2, 'RB paid 0.1 a carry');
});

test('a position with no rules scores nothing rather than crashing', () => {
  const players = [{ position: 'K', games: [{ receptions: 1 }] }];
  scorePlayers(players, PRESETS.ppr);
  assert.equal(players[0].games[0].fantasy_points, null);
});

test('the prior-season baseline is re-scored from its stored averages', () => {
  const players = [{
    position: 'WR',
    games: [],
    baseline: { components: { receptions: 5, receiving_yards: 60, receiving_tds: 0.5 } },
  }];
  scorePlayers(players, PRESETS.ppr);
  assert.equal(players[0].baseline.points, 14);      // 5 + 6 + 3
  scorePlayers(players, PRESETS.standard);
  assert.equal(players[0].baseline.points, 9, 'the baseline follows the scoring change too');
});

// ---- null discipline ----

test('a component the source did not supply contributes nothing', () => {
  assert.equal(scoreGame({ receptions: 3, receiving_yards: 30 }, PRESETS.ppr.WR), 6);
});

test('a row with no scoring components at all is null, not zero', () => {
  assert.equal(scoreGame({ snap_pct: 0.8, week: 4 }, PRESETS.ppr.WR), null);
  assert.equal(scoreGame(null, PRESETS.ppr.WR), null);
  assert.equal(scoreGame({ receptions: 0 }, PRESETS.ppr.WR), 0, 'an explicit zero IS zero');
});

// ---- rule set resolution ----

test('rulesFor resolves presets and fills gaps in a custom set', () => {
  assert.deepEqual(rulesFor({ preset: 'standard' }).WR.receptions, [0, 1]);
  assert.deepEqual(rulesFor(null).WR.receptions, [1, 1], 'no setting means PPR');
  assert.deepEqual(rulesFor({ preset: 'nonsense' }).WR.receptions, [1, 1], 'unknown preset falls back');

  const partial = rulesFor({ preset: 'custom', rules: { WR: { receptions: [2, 1] } } });
  assert.deepEqual(partial.WR.receptions, [2, 1]);
  assert.deepEqual(partial.WR.receiving_tds, PRESETS.ppr.WR.receiving_tds,
    'an unspecified category keeps its default rather than scoring zero');
});

test('a flat pre-position rule set is spread across the positions', () => {
  // Upgrading must not drop settings the user already entered.
  const flat = { receptions: 0.5, rushing_tds: 6, passing_yards: 0.04 };
  const m = migrateFlatRules(flat);
  for (const pos of POSITIONS) {
    assert.deepEqual(m[pos].receptions, [0.5, 1], `${pos} keeps the old reception value`);
  }
  assert.deepEqual(m.QB.passing_yards, [0.04, 1]);
});

test('describeRules names a preset, or says custom', () => {
  assert.equal(describeRules(PRESETS.ppr), 'ppr');
  assert.equal(describeRules(PRESETS.half_ppr), 'half_ppr');
  assert.equal(describeRules(PRESETS.standard), 'standard');
  const tweaked = normalizeRules(PRESETS.ppr);
  tweaked.QB.completions = [1, 1];
  assert.equal(describeRules(tweaked), 'custom');
});

test('describeRules compares rates, not how they were written', () => {
  const rewritten = normalizeRules(PRESETS.ppr);
  rewritten.QB.passing_yards = [0.04, 1];       // same rate as [1, 25]
  assert.equal(describeRules(rewritten), 'ppr');
});

test('copying one position onto another leaves the source alone', () => {
  const rules = normalizeRules(PRESETS.ppr);
  rules.RB.carries = [0.1, 1];
  const copied = copyPosition(rules, 'RB', 'WR');
  assert.deepEqual(copied.WR.carries, [0.1, 1]);
  assert.deepEqual(copied.RB.carries, [0.1, 1]);
  assert.deepEqual(rules.WR.carries, [0, 1], 'the original object is not mutated');
});

// ---- long-play bonuses ----

test('a long-TD bonus is additive on top of the touchdown\'s own points', () => {
  // The evidence this whole feature came from: Bijan's week 17 was 22/195/1
  // rushing plus 5/34/1 receiving, which is 39.9 under PPR. Yahoo showed
  // 42.90 — a 3-point bonus for the 40+ yard score, not a replacement for it.
  const game = {
    carries: 22, rushing_yards: 195, rushing_tds: 1, rushing_40: 1, rushing_40_tds: 1,
    targets: 8, receptions: 5, receiving_yards: 34, receiving_tds: 1,
  };
  assert.equal(scoreGame(game, PRESETS.ppr.RB), 39.9);
  const rules = normalizeRules({ RB: { ...PRESETS.ppr.RB, rushing_40_tds: [3, 1] } });
  assert.equal(scoreGame(game, rules.RB), 42.9);
});

test('the stock presets pay nothing for long plays or milestones', () => {
  // This is what keeps the PPR preset reproducing nflverse exactly after nine
  // categories were added to the table.
  for (const preset of Object.values(PRESETS)) {
    for (const pos of POSITIONS) {
      for (const key of ['passing_40', 'passing_40_tds', 'rushing_40', 'rushing_40_tds',
        'receiving_40', 'receiving_40_tds', 'passing_300_game', 'rushing_100_game', 'receiving_100_game']) {
        assert.equal(preset[pos][key][0], 0, `${pos} ${key} must default to zero points`);
      }
    }
  }
});

// ---- milestones ----

// These use bare rule tables rather than normalizeRules, so the milestone is
// the only thing scoring — otherwise the filled-in per-yard default pays too
// and the assertion stops being about the threshold.
const milestoneOnly = { rushing_yards: [0, 1], rushing_100_game: [10, 100] };

test('a milestone pays once at the mark and nothing below it', () => {
  assert.equal(scoreGame({ rushing_yards: 99 }, milestoneOnly), 0);
  assert.equal(scoreGame({ rushing_yards: 100 }, milestoneOnly), 10, 'the mark itself pays');
  assert.equal(scoreGame({ rushing_yards: 101 }, milestoneOnly), 10);
});

test('a milestone is not prorated — 195 yards is one 100-yard game, not two', () => {
  assert.equal(scoreGame({ rushing_yards: 195 }, milestoneOnly), 10);
  assert.equal(scoreGame({ rushing_yards: 240 }, milestoneOnly), 10);
});

test('the threshold is editable, so a 150-yard league can say so', () => {
  const rules = { rushing_yards: [0, 1], rushing_100_game: [5, 150] };
  assert.equal(scoreGame({ rushing_yards: 120 }, rules), 0);
  assert.equal(scoreGame({ rushing_yards: 150 }, rules), 5);
});

test('a milestone reads the same stat its rate rule does, without double-naming it', () => {
  // Both rules fire on one game: 12 points of yardage plus the bonus.
  const rules = normalizeRules({ RB: { rushing_yards: [1, 10], rushing_100_game: [3, 100] } });
  assert.equal(scoreGame({ rushing_yards: 120 }, rules.RB), 15);
});

test('a row of nothing but milestone stats does not become a confident zero', () => {
  // Milestones read a field another rule owns, so they must not be what makes
  // a row count as having data.
  const rules = normalizeRules({ RB: { rushing_100_game: [10, 100] } });
  assert.equal(scoreGame({ snap_pct: 0.8 }, rules.RB), null);
});

test('scoreAverages leaves milestones out, because a threshold is not linear', () => {
  // A back averaging 95 yards may well have had six 100-yard games; scoring
  // the average pays zero. A back averaging 105 would be paid on every game
  // including the ones he missed. Both answers are wrong and invisible.
  const rules = normalizeRules({ RB: { rushing_yards: [1, 10], rushing_100_game: [10, 100] } });
  const averages = { rushing_yards: 105 };
  assert.equal(scoreGame(averages, rules.RB), 20.5, 'a real game would be paid the bonus');
  assert.equal(scoreAverages(averages, rules.RB), 10.5, 'per-game averages are not');
});

test('the prior-season baseline is re-scored without milestone bonuses', () => {
  const players = [{
    position: 'RB', games: [],
    baseline: { season: 2024, games: 16, components: { rushing_yards: 110 } },
  }];
  scorePlayers(players, normalizeRules({ RB: { rushing_yards: [1, 10], rushing_100_game: [10, 100] } }));
  assert.equal(players[0].baseline.points, 11, 'yardage only — no bonus off an average');
});

test('describeRules ignores a milestone threshold when the bonus is worth nothing', () => {
  const rules = normalizeRules(PRESETS.ppr);
  rules.RB.rushing_100_game = [0, 150];        // a different mark, still worth 0
  assert.equal(describeRules(rules), 'ppr');
  rules.RB.rushing_100_game = [5, 150];        // now it pays
  assert.equal(describeRules(rules), 'custom');
});

// ---- linearity (what lets a baseline re-score from averages) ----

test('scoring is linear, which is what lets a baseline re-score from averages', () => {
  const games = [
    { receptions: 10, receiving_yards: 120, receiving_tds: 2 },
    { receptions: 2, receiving_yards: 15, receiving_tds: 0 },
    { receptions: 5, receiving_yards: 61, receiving_tds: 1 },
  ];
  for (const preset of Object.values(PRESETS)) {
    const meanOfScores = games.reduce((t, g) => t + scoreGame(g, preset.WR), 0) / games.length;
    const averages = {};
    for (const f of SCORING_FIELDS) {
      averages[f] = games.reduce((t, g) => t + (g[f] ?? 0), 0) / games.length;
    }
    // Exact in the arithmetic; the gap is scoreGame rounding to two decimals.
    assert.ok(Math.abs(meanOfScores - scoreGame(averages, preset.WR)) <= 0.005);
  }
});

// ---- the real-data check ----

test('PPR rules reproduce nflverse\'s own figure on every stored game log', (t) => {
  const dbPath = join(ROOT, 'data', 'players.json');
  if (!existsSync(dbPath)) return t.skip('data/players.json not built');

  const db = JSON.parse(readFileSync(dbPath, 'utf8'));
  let checked = 0;
  const mismatches = [];
  for (const p of db.players) {
    const rules = PRESETS.ppr[p.position];
    if (!rules) continue;                       // K/DST have no offensive rules
    for (const g of p.games ?? []) {
      if (g.fantasy_points_ppr == null) continue;
      checked++;
      const computed = scoreGame(g, rules);
      if (Math.abs(computed - g.fantasy_points_ppr) > 0.051) {
        mismatches.push(`${p.position} ${p.name} wk${g.week}: computed ${computed} vs nflverse ${g.fantasy_points_ppr}`);
      }
    }
  }
  assert.ok(checked > 500, `expected a substantial sample, checked ${checked}`);
  assert.deepEqual(mismatches, [], `${mismatches.length} of ${checked} game logs disagree`);
});
