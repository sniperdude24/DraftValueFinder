import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSeason } from '../src/normalize/season.js';
import { computeTrend } from '../src/analyze/trends.js';
import { recommendations } from '../src/analyze/recommend.js';
import { assessAll } from '../src/analyze/score.js';

// ---- mode resolution ----

test('pre-season → draft mode on last season stats, regardless of stats availability', () => {
  const r = resolveSeason({ season: '2026', season_type: 'pre', week: 1 }, false);
  assert.deepEqual([r.mode, r.stats_season, r.baseline_season, r.week], ['draft', 2025, null, null]);
  const r2 = resolveSeason({ season: '2026', season_type: 'pre', week: 1 }, true);
  assert.equal(r2.mode, 'draft');
});

test('regular season + current stats available → season mode with baseline', () => {
  const r = resolveSeason({ season: '2026', season_type: 'regular', week: 3 }, true);
  assert.deepEqual([r.mode, r.stats_season, r.baseline_season, r.week], ['season', 2026, 2025, 3]);
});

test('regular season but stats not yet published → stays in draft mode', () => {
  const r = resolveSeason({ season: '2026', season_type: 'regular', week: 1 }, false);
  assert.equal(r.mode, 'draft');
  assert.equal(r.stats_season, 2025);
});

test('post season behaves like regular season', () => {
  assert.equal(resolveSeason({ season: '2026', season_type: 'post', week: 19 }, true).mode, 'season');
});

// ---- early-season baseline trends ----

function seasonPlayer(games, baseline) {
  return {
    position: 'WR', stats_season: 2026, meta: { years_exp: 4 },
    games: games.map(([snap, tgt, ppr], i) => ({
      week: i + 1, snap_pct: snap, targets: tgt, receptions: Math.round(tgt * 0.7),
      carries: 0, attempts: 0, fantasy_points: ppr, target_share: null,
    })),
    baseline,
  };
}

const modestBaseline = { season: 2025, games: 15, snap_pct: 0.45, targets: 4.0, carries: 0, attempts: 0, ppr: 7.5 };

test('week-1 role jump vs prior-season baseline → rising, basis labeled', () => {
  const t = computeTrend(seasonPlayer([[0.85, 9, 14]], modestBaseline));
  assert.ok(t.available);
  assert.equal(t.basis.type, 'prior-baseline');
  assert.equal(t.usage, 'rising');
  assert.match(t.basis.window_label, /2025 per-game baseline/);
  assert.ok(t.notes.some(n => /baseline/i.test(n)), 'must state the comparison basis in plain text');
});

test('early-season usage matching the baseline → flat, not rising', () => {
  const t = computeTrend(seasonPlayer([[0.46, 4, 8], [0.44, 4, 7]], modestBaseline));
  assert.equal(t.basis.type, 'prior-baseline');
  assert.equal(t.usage, 'flat');
});

test('few games and NO baseline → unavailable with reason', () => {
  const t = computeTrend(seasonPlayer([[0.85, 9, 14]], null));
  assert.equal(t.available, false);
  assert.match(t.reason, /no usable prior-season baseline/i);
});

test('thin baseline (under 6 games) is not trusted', () => {
  const t = computeTrend(seasonPlayer([[0.85, 9, 14]], { ...modestBaseline, games: 3 }));
  assert.equal(t.available, false);
});

test('4+ current-season games ignore the baseline (same-season comparison wins)', () => {
  const games = [[0.6, 6, 10], [0.6, 6, 10], [0.6, 6, 10], [0.6, 6, 10], [0.7, 8, 13], [0.72, 8, 13], [0.74, 9, 14]];
  const t = computeTrend(seasonPlayer(games, modestBaseline));
  assert.equal(t.basis.type, 'season');
  assert.equal(t.usage, 'rising');
});

test('point spike without usage growth is still flagged on the baseline path', () => {
  // Usage identical to baseline, points way up (TD luck in week 1).
  const t = computeTrend(seasonPlayer([[0.45, 4, 22]], modestBaseline));
  assert.equal(t.basis.type, 'prior-baseline');
  assert.ok(t.flags.unsustainable_spike);
  assert.notEqual(t.usage, 'rising');
});

// ---- season-mode recommendations (waiver targets) ----

function mkPlayer(id, pos, rank) {
  return {
    id, name: id, position: pos, team: 'KC', stats_team: 'KC', changed_team: false, bye: 8,
    stats_season: 2026, meta: { years_exp: 3, injury_status: null },
    adp: { rank, overall: rank, formatted: 'x', stdev: 2, stale: true },
    expert: { rank, tier: Math.ceil(rank / 4), stdev: 4, scope: 'rest-of-season' },
    games: Array.from({ length: 8 }, (_, i) => ({
      week: i + 1, snap_pct: 0.6, targets: 6, receptions: 4, carries: pos === 'RB' ? 12 : 0,
      attempts: pos === 'QB' ? 30 : 0, fantasy_points: 12, target_share: null,
    })),
    baseline: null,
  };
}

test('season mode drops the ADP pick-value component', () => {
  const players = ['RB', 'WR', 'RB', 'WR', 'TE', 'QB'].map((pos, i) => mkPlayer(`${pos}-p${i}`, pos, i + 1));
  const assess = assessAll(players);
  // Half the league is rostered — in draft mode the unrostered #1 would show
  // huge value-vs-pick; in season mode value must be null and never cited.
  const drafted = players.slice(1, 4).map(p => p.id);
  const r = recommendations(players, assess, { drafted, mine: [drafted[0]], personalRanks: {} }, { mode: 'season' });
  assert.equal(r.mode, 'season');
  for (const rec of r.recommendations) {
    assert.equal(rec.value_vs_pick, null);
    assert.ok(!rec.why.some(w => /still available at pick/i.test(w)), 'draft value language must not appear');
  }
  // Roster-need reasoning still works.
  assert.ok(r.recommendations.some(rec => rec.why.some(w => /starting-roster need/i.test(w))));
});
