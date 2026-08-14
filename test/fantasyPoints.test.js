import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scoreGame, rulesFor, describeRules, PRESETS, PPR_RULES, SCORING_FIELDS,
} from '../src/analyze/fantasyPoints.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// A 100-yard, 8-catch, 1-TD receiving line.
const receivingGame = {
  receptions: 8, receiving_yards: 100, receiving_tds: 1,
  rushing_yards: 0, rushing_tds: 0, passing_yards: 0, passing_tds: 0,
  interceptions: 0, two_point_conversions: 0, fumbles_lost: 0, special_teams_tds: 0,
};

test('PPR scores a receiving line the standard way', () => {
  // 8 catches + 10 (100 yards) + 6 (TD) = 24
  assert.equal(scoreGame(receivingGame, PRESETS.ppr), 24);
});

test('the presets differ only in what a catch is worth', () => {
  assert.equal(scoreGame(receivingGame, PRESETS.half_ppr), 20, 'half a point per catch');
  assert.equal(scoreGame(receivingGame, PRESETS.standard), 16, 'no points per catch');
  // Everything except the reception term must be identical across formats.
  for (const field of SCORING_FIELDS) {
    if (field === 'receptions') continue;
    assert.equal(PRESETS.half_ppr[field], PRESETS.ppr[field], field);
    assert.equal(PRESETS.standard[field], PRESETS.ppr[field], field);
  }
});

test('a passing line scores identically in every format', () => {
  // Nothing a QB does under center involves a reception, so the formats
  // cannot separate quarterbacks — a useful control on the whole engine.
  const qb = { passing_yards: 300, passing_tds: 3, interceptions: 1, rushing_yards: 20, rushing_tds: 0 };
  const ppr = scoreGame(qb, PRESETS.ppr);
  assert.equal(ppr, 12 + 12 - 2 + 2);
  assert.equal(scoreGame(qb, PRESETS.half_ppr), ppr);
  assert.equal(scoreGame(qb, PRESETS.standard), ppr);
});

test('special-teams fumbles are never charged to the player', () => {
  // The bug this pins: `fumbles_lost_total` includes muffed punts and kick
  // returns, which fantasy does not penalize. build.js must supply OFFENSIVE
  // fumbles only, and scoring must never reach for the raw total.
  const returner = { receptions: 2, receiving_yards: 20, fumbles_lost: 0, special_teams_tds: 0 };
  assert.equal(scoreGame(returner, PRESETS.ppr), 4, 'a muffed punt must not cost points here');

  const fumbledFromScrimmage = { ...returner, fumbles_lost: 1 };
  assert.equal(scoreGame(fumbledFromScrimmage, PRESETS.ppr), 2, 'an offensive fumble does cost 2');
});

test('a component the source did not supply contributes nothing', () => {
  const sparse = { receptions: 3, receiving_yards: 30 };
  assert.equal(scoreGame(sparse, PRESETS.ppr), 6);
});

test('a row with no scoring components at all is null, not zero', () => {
  // "Undefined" and "held scoreless" are different claims and the UI renders
  // them differently — a bare snap-count row must not read as 0.0 points.
  assert.equal(scoreGame({ snap_pct: 0.8, week: 4 }, PRESETS.ppr), null);
  assert.equal(scoreGame(null, PRESETS.ppr), null);
  assert.equal(scoreGame({ receptions: 0 }, PRESETS.ppr), 0, 'an explicit zero IS zero');
});

test('rulesFor resolves presets and fills gaps in a custom set', () => {
  assert.equal(rulesFor({ preset: 'standard' }).receptions, 0);
  assert.equal(rulesFor(null).receptions, 1, 'no setting means PPR');
  assert.equal(rulesFor({ preset: 'nonsense' }).receptions, 1, 'an unknown preset falls back, never breaks');

  // A partial custom set must inherit the rest rather than scoring them as 0.
  const partial = rulesFor({ preset: 'custom', rules: { receptions: 2 } });
  assert.equal(partial.receptions, 2);
  assert.equal(partial.passing_tds, PPR_RULES.passing_tds);
});

test('describeRules names a preset, or says custom', () => {
  assert.equal(describeRules(PRESETS.ppr), 'ppr');
  assert.equal(describeRules(PRESETS.half_ppr), 'half_ppr');
  assert.equal(describeRules(PRESETS.standard), 'standard');
  assert.equal(describeRules({ ...PRESETS.ppr, receiving_tds: 7 }), 'custom');
});

test('scoring is linear, which is what lets a baseline re-score from averages', () => {
  // The baseline season's game rows are not retained — only per-game
  // component averages. That is only sound because scoring the averages
  // equals averaging the scores.
  const games = [
    { receptions: 10, receiving_yards: 120, receiving_tds: 2 },
    { receptions: 2, receiving_yards: 15, receiving_tds: 0 },
    { receptions: 5, receiving_yards: 61, receiving_tds: 1 },
  ];
  for (const preset of Object.values(PRESETS)) {
    const meanOfScores = games.reduce((t, g) => t + scoreGame(g, preset), 0) / games.length;
    const averages = {};
    for (const f of SCORING_FIELDS) {
      averages[f] = games.reduce((t, g) => t + (g[f] ?? 0), 0) / games.length;
    }
    const scoreOfMeans = scoreGame(averages, preset);
    // Exact in the arithmetic; the only gap is scoreGame rounding its result
    // to two decimals, which bounds the difference at half a cent — far
    // below the tenth of a point the baseline is ever displayed to.
    assert.ok(Math.abs(meanOfScores - scoreOfMeans) <= 0.005,
      `linearity broken beyond rounding: ${meanOfScores} vs ${scoreOfMeans}`);
  }
});

// ---- the real-data check ----
// players.json is a generated artifact, so this skips cleanly without it.
test('PPR rules reproduce nflverse\'s own figure on every stored game log', (t) => {
  const dbPath = join(ROOT, 'data', 'players.json');
  if (!existsSync(dbPath)) return t.skip('data/players.json not built');

  const db = JSON.parse(readFileSync(dbPath, 'utf8'));
  let checked = 0;
  const mismatches = [];
  for (const p of db.players) {
    for (const g of p.games ?? []) {
      if (g.fantasy_points_ppr == null) continue;
      checked++;
      const computed = scoreGame(g, PRESETS.ppr);
      // The stored reference is rounded to one decimal.
      if (Math.abs(computed - g.fantasy_points_ppr) > 0.051) {
        mismatches.push(`${p.name} wk${g.week}: computed ${computed} vs nflverse ${g.fantasy_points_ppr}`);
      }
    }
  }
  assert.ok(checked > 500, `expected a substantial sample, checked ${checked}`);
  assert.deepEqual(mismatches, [], `${mismatches.length} of ${checked} game logs disagree`);
});
