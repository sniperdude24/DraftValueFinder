import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowStats, computeWindows } from '../src/analyze/playerStats.js';

function game(week, o = {}) {
  return {
    week, snap_pct: 0.7, targets: 0, receptions: 0, receiving_yards: 0, receiving_tds: 0,
    carries: 0, rushing_yards: 0, rushing_tds: 0, attempts: 0, passing_yards: 0, passing_tds: 0,
    fantasy_points: 0, target_share: null, air_yards_share: null, wopr: null,
    receiving_air_yards: null, receiving_yac: null, receiving_first_downs: 0, receiving_epa: null,
    receiving_20: 0, rushing_first_downs: 0, rushing_epa: null, rushing_20: 0, racr: null,
    ...o,
  };
}

test('rate stats come from window totals, not a mean of per-game ratios', () => {
  // Per-game ratios would be (1/1=1.0) and (150/10=15.0) → mean 8.0.
  // From totals: 151 yards / 11 targets = 13.7. The low-volume game must
  // not carry equal weight.
  const s = windowStats([
    game(1, { targets: 1, receptions: 1, receiving_yards: 1 }),
    game(2, { targets: 10, receptions: 8, receiving_yards: 150 }),
  ]);
  assert.equal(s.yards_per_target, 13.73);
  assert.notEqual(s.yards_per_target, 8);
});

test('catch rate and yards per carry also use totals', () => {
  const s = windowStats([
    game(1, { targets: 2, receptions: 1, receiving_yards: 10, carries: 1, rushing_yards: 2 }),
    game(2, { targets: 8, receptions: 7, receiving_yards: 90, carries: 9, rushing_yards: 58 }),
  ]);
  assert.equal(s.catch_rate, 0.8);        // 8/10, not mean(0.5, 0.875)
  assert.equal(s.yards_per_carry, 6);      // 60/10, not mean(2, 6.44)
});

test('share stats are means of per-game values, not recomputed from totals', () => {
  const s = windowStats([
    game(1, { targets: 5, target_share: 0.20, air_yards_share: 0.30, wopr: 0.51 }),
    game(2, { targets: 15, target_share: 0.40, air_yards_share: 0.50, wopr: 0.95 }),
  ]);
  assert.equal(s.target_share, 0.3);       // mean of .20/.40
  assert.equal(s.air_yards_share, 0.4);
  assert.equal(s.wopr, 0.73);
});

test('zero denominators yield null, never NaN or Infinity', () => {
  const s = windowStats([game(1), game(2)]);
  for (const k of ['yards_per_target', 'catch_rate', 'yards_per_carry', 'yards_per_reception', 'yac_per_reception', 'yards_per_attempt', 'ppr_per_opportunity']) {
    assert.equal(s[k], null, `${k} must be null with zero volume`);
    assert.ok(!Number.isNaN(s[k]));
  }
});

test('absent advanced fields degrade to null rather than zero', () => {
  const s = windowStats([game(1, { targets: 4, receptions: 3, receiving_yards: 40 })]);
  assert.equal(s.wopr, null);
  assert.equal(s.target_share, null);
  assert.equal(s.racr, null);
  assert.equal(s.yards_per_target, 10); // real data still computes
});

test('per-game volume divides by games in the window', () => {
  const s = windowStats([
    game(1, { targets: 10, carries: 2, fantasy_points: 20 }),
    game(2, { targets: 6, carries: 0, fantasy_points: 10 }),
  ]);
  assert.equal(s.targets_pg, 8);
  assert.equal(s.opportunities_pg, 9);   // (16 targets + 2 carries) / 2
  assert.equal(s.ppr_pg, 15);
});

test('opportunity is position-aware and matches the trend engine', () => {
  const g = [game(1, { targets: 4, carries: 2, attempts: 30 })];
  // QB: pass attempts + carries (32). WR: targets only (4). RB: carries + targets (6).
  assert.equal(windowStats(g, 'QB').opportunities_pg, 32);
  assert.equal(windowStats(g, 'WR').opportunities_pg, 4);
  assert.equal(windowStats(g, 'RB').opportunities_pg, 6);
});

test('QB EPA per play does not double-count pass attempts', () => {
  const g = [game(1, { attempts: 30, carries: 0, targets: 0, passing_epa: 15 })];
  // 30 plays, 15 EPA → 0.5. Double-counting attempts would halve it.
  assert.equal(windowStats(g, 'QB').epa_per_play, 0.5);
});

test('computeWindows slices season / last3 / last1', () => {
  const games = [1, 2, 3, 4, 5].map(w => game(w, { targets: w, receptions: w, receiving_yards: w * 10 }));
  const w = computeWindows({ games });
  assert.equal(w.season.games, 5);
  assert.deepEqual(w.last3.weeks, [3, 4, 5]);
  assert.deepEqual(w.last1.weeks, [5]);
  assert.equal(w.last1.targets_pg, 5);
});

test('fewer than three games: last3 returns what exists, no fabrication', () => {
  const w = computeWindows({ games: [game(1, { targets: 4 }), game(2, { targets: 6 })] });
  assert.equal(w.last3.games, 2);
  assert.deepEqual(w.last3.weeks, [1, 2]);
});

test('no games at all: every window is null', () => {
  assert.deepEqual(computeWindows({ games: [] }), { season: null, last3: null, last1: null });
  assert.deepEqual(computeWindows({}), { season: null, last3: null, last1: null });
});

test('totals sum TDs and explosive plays across receiving and rushing', () => {
  const s = windowStats([
    game(1, { receiving_tds: 1, rushing_tds: 1, receiving_20: 2, rushing_20: 1 }),
    game(2, { receiving_tds: 2, receiving_20: 1 }),
  ]);
  assert.equal(s.tds_total, 4);
  assert.equal(s.explosive_total, 4);
});
