import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachProjections, projectionWeek } from '../src/normalize/projections.js';

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
