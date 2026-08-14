import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachProjections, projectionWeek, projectionComponents } from '../src/normalize/projections.js';
import { scorePlayers, normalizeRules, PRESETS } from '../src/analyze/fantasyPoints.js';

test('projectionWeek: draft prep targets week 1; in-season targets the current week', () => {
  assert.deepEqual(projectionWeek({ season: '2026', season_type: 'pre', week: 3 }), { season: 2026, week: 1 });
  assert.deepEqual(projectionWeek({ season: '2026', season_type: 'regular', week: 7 }), { season: 2026, week: 7 });
  assert.deepEqual(projectionWeek({ season: '2026', season_type: 'post', week: 19 }), { season: 2026, week: 19 });
});

function mk(id, sleeperId) {
  return { id, name: id, position: 'WR', meta: sleeperId ? { sleeper_id: sleeperId } : null };
}

test('attachProjections joins by sleeper_id and filters detail keys', () => {
  const players = [mk('WR-a', '1001'), mk('WR-b', '1002'), mk('WR-c', null)];
  const snapshot = { season: 2026, week: 1, projections: {
    1001: { pts_ppr: 14.37, rec: 5.2, rec_tgt: 7.1, rec_yd: 64.9, rec_td: 0.42, adp_dd_ppr: 55, gp: 1, off_snp: 60 },
  } };
  const r = attachProjections(players, snapshot);
  assert.equal(r.attached, 1);
  assert.equal(players[0].projection.pts_ppr, 14.4);
  assert.equal(players[0].projection.week, 1);
  assert.equal(players[0].projection.detail.rec_tgt, 7.1);
  assert.ok(!('adp_dd_ppr' in players[0].projection.detail), 'non-display keys are dropped');
  assert.ok(!('off_snp' in players[0].projection.detail));
  assert.equal(players[1].projection, null, 'no projection entry → null');
  assert.equal(players[2].projection, null, 'no sleeper_id → null, never throws');
});

test('attachProjections is safe on empty/missing snapshots', () => {
  const players = [mk('WR-a', '1001')];
  assert.equal(attachProjections(players, null).attached, 0);
  assert.equal(players[0].projection, null);
  assert.equal(attachProjections(players, { projections: {} }).attached, 0);
});

test('entries without pts_ppr are ignored (ADP stubs)', () => {
  const players = [mk('WR-a', '1001')];
  attachProjections(players, { season: 2026, week: 1, projections: { 1001: { adp_dd_ppr: 55 } } });
  assert.equal(players[0].projection, null);
});

// ---- scoring a projection under the user's own rules ----
//
// Sleeper publishes a PPR total, which is useless to a league that is not PPR.
// It also publishes the COMPONENTS, which this app can price itself.

test('Sleeper field names map onto this app\'s components', () => {
  const c = projectionComponents({ pass_yd: 260, pass_td: 2, rush_att: 4, rec: 5, rec_yd: 60, rec_td: 1 });
  assert.equal(c.passing_yards, 260);
  assert.equal(c.passing_tds, 2);
  assert.equal(c.carries, 4);
  assert.equal(c.receptions, 5);
  assert.equal(c.receiving_yards, 60);
  assert.equal(c.receiving_tds, 1);
});

test('the three two-point varieties collapse into one category', () => {
  // Same treatment a real game row gets in normalize/build.js — no scoring
  // system prices them separately.
  const c = projectionComponents({ rec: 4, pass_2pt: 0.05, rush_2pt: 0.02, rec_2pt: 0.03 });
  assert.equal(c.two_point_conversions, 0.1);
});

test('Sleeper\'s 40+ yard plays are carried so a long-play bonus is not missed', () => {
  const c = projectionComponents({ pass_cmp_40p: 0.32, rush_40p: 0.06, rec_40p: 0.4, fum_lost: 0.13 });
  assert.equal(c.passing_40, 0.32);
  assert.equal(c.rushing_40, 0.06);
  assert.equal(c.receiving_40, 0.4);
  assert.equal(c.fumbles_lost, 0.13);
  // Sleeper does not project WHICH long plays score, so the 40+ yard TD
  // categories stay absent rather than being estimated from the play count.
  assert.equal('rushing_40_tds' in c, false);
  assert.equal('receiving_40_tds' in c, false);
});

test('a component the projection does not carry is absent, not zero', () => {
  const c = projectionComponents({ rec: 5, rec_yd: 60 });
  assert.equal('fumbles_lost' in c, false);
  assert.equal('passing_yards' in c, false, 'a receiver projection has no passing line');
});

test('a projection with nothing mappable is null rather than an empty line', () => {
  assert.equal(projectionComponents({ fgm: 2, xpm: 3 }), null, 'kicker stats do not map');
  assert.equal(projectionComponents(null), null);
});

test('attachProjections stores components alongside the external figure', () => {
  const players = [mk('RB-a', '4034')];
  attachProjections(players, {
    season: 2026, week: 3,
    projections: { 4034: { pts_ppr: 17.2, rush_att: 16, rush_yd: 78, rec: 3, rec_yd: 24 } },
  });
  const proj = players[0].projection;
  assert.equal(proj.pts_ppr, 17.2, "Sleeper's own number is kept as published");
  assert.equal(proj.components.carries, 16);
  assert.equal(proj.components.receiving_yards, 24);
});

test('a projection is scored under the user\'s rules, not left at Sleeper\'s PPR', () => {
  const players = [{
    position: 'WR', games: [],
    projection: { week: 3, pts_ppr: 14, components: { receptions: 5, receiving_yards: 60, receiving_tds: 0.5 } },
  }];
  scorePlayers(players, PRESETS.ppr);
  assert.equal(players[0].projection.points, 14);        // 5 + 6 + 3
  scorePlayers(players, PRESETS.standard);
  assert.equal(players[0].projection.points, 9, 'the projection follows a scoring change');
  assert.equal(players[0].projection.pts_ppr, 14, "Sleeper's figure is never overwritten");
});

test('milestones are excluded from a projection', () => {
  // A projection is an expectation, not a game. Projecting 105 rushing yards
  // says nothing about how often the 100-yard mark is actually crossed, so
  // paying the bonus off it is the same error as paying it off a season
  // average — which is what scoreAverages exists to prevent.
  const rules = normalizeRules({ RB: { rushing_yards: [1, 10], rushing_100_game: [10, 100] } });
  const players = [{
    position: 'RB', games: [],
    projection: { week: 3, pts_ppr: 12, components: { rushing_yards: 105 } },
  }];
  scorePlayers(players, rules);
  assert.equal(players[0].projection.points, 10.5, 'yardage only — no 100-yard bonus off a projection');
});

test('scoring does not conjure a projection for a player who has none', () => {
  const players = [{ position: 'RB', games: [], projection: null }];
  scorePlayers(players, PRESETS.ppr);
  assert.equal(players[0].projection, null);
});
