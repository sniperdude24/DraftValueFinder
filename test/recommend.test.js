import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rosterSummary, LEAGUE } from '../src/analyze/roster.js';
import { recommendations, tierScarcity } from '../src/analyze/recommend.js';
import { assessAll } from '../src/analyze/score.js';

function mkPlayer(id, pos, { adpRank, expertRank, tier = 3, bye = 8 } = {}) {
  return {
    id, name: id, position: pos, team: 'KC', team_2025: 'KC', changed_team: false, bye,
    meta: { years_exp: 3, injury_status: null },
    adp: adpRank ? { rank: adpRank, overall: adpRank, formatted: 'x', stdev: 2 } : null,
    expert: expertRank ? { rank: expertRank, tier, stdev: 4 } : null,
    games_2025: Array.from({ length: 8 }, (_, i) => ({
      week: i + 1, snap_pct: 0.6, targets: 6, receptions: 4, carries: pos === 'RB' ? 12 : 0,
      attempts: pos === 'QB' ? 30 : 0, fantasy_points_ppr: 12, target_share: null,
    })),
  };
}

function universe() {
  const players = [];
  let rank = 1;
  for (const pos of ['RB', 'WR', 'RB', 'WR', 'TE', 'QB', 'RB', 'WR', 'TE', 'QB', 'RB', 'WR']) {
    players.push(mkPlayer(`${pos}-p${rank}`, pos, { adpRank: rank, expertRank: rank, tier: Math.ceil(rank / 4) }));
    rank++;
  }
  players.push(mkPlayer('K-k1', 'K', { adpRank: 140, expertRank: 140 }));
  players.push(mkPlayer('DST-d1', 'DST', { adpRank: 130, expertRank: 130 }));
  return players;
}

test('rosterSummary computes needs and bye conflicts', () => {
  const mine = [mkPlayer('RB-x', 'RB', { bye: 7 }), mkPlayer('RB-y', 'RB', { bye: 7 }), mkPlayer('WR-z', 'WR', { bye: 7 })];
  const r = rosterSummary(mine);
  assert.equal(r.counts.RB, 2);
  assert.ok(r.needs.some(n => n.position === 'QB'));
  assert.ok(!r.needs.some(n => n.position === 'RB'), 'RB starters are filled');
  assert.equal(r.byeConflicts.length, 1);
  assert.equal(r.byeConflicts[0].week, 7);
});

test('drafted players never appear in recommendations', () => {
  const players = universe();
  const assess = assessAll(players);
  const drafted = players.slice(0, 3).map(p => p.id);
  const r = recommendations(players, assess, { drafted, mine: [drafted[0]], personalRanks: {} });
  for (const rec of r.recommendations) assert.ok(!drafted.includes(rec.id));
  assert.equal(r.current_pick, 4);
});

test('K/DST are not recommended in early rounds', () => {
  const players = universe();
  const assess = assessAll(players);
  const r = recommendations(players, assess, { drafted: [], mine: [], personalRanks: {} });
  assert.ok(!r.recommendations.some(rec => ['K', 'DST'].includes(rec.position)));
});

test('falling player is cited as value vs current pick', () => {
  const players = universe();
  const assess = assessAll(players);
  // First 6 picks made, but the #1 player somehow undrafted → big value.
  const drafted = players.slice(1, 7).map(p => p.id);
  const r = recommendations(players, assess, { drafted, mine: [], personalRanks: {} });
  const top = r.recommendations.find(rec => rec.id === players[0].id);
  assert.ok(top, '#1 player should be recommended');
  assert.ok(top.value_vs_pick > 0);
  assert.ok(top.why.some(w => /still available/i.test(w)), 'value must be explained');
});

test('personal rank is surfaced, never overridden', () => {
  const players = universe();
  const assess = assessAll(players);
  const target = players[0].id;
  const r = recommendations(players, assess, { drafted: [], mine: [], personalRanks: { [target]: 1 } });
  const rec = r.recommendations.find(x => x.id === target);
  assert.ok(rec.why.some(w => /your personal rank: #1/i.test(w)));
});

test('warns when unfilled starters equal remaining picks', () => {
  const players = universe();
  const assess = assessAll(players);
  // 9 picks used on WRs only → 8 remaining starter needs vs 6 picks left.
  const mine = Array.from({ length: 9 }, (_, i) => mkPlayer(`WR-mine${i}`, 'WR'));
  const all = [...players, ...mine];
  const assessAllRes = assessAll(all);
  const r = recommendations(all, assessAllRes, { drafted: mine.map(p => p.id), mine: mine.map(p => p.id), personalRanks: {} });
  assert.ok(r.position_warnings.some(w => /prioritize starters/i.test(w)));
});

test('tierScarcity counts remaining players in best tier', () => {
  const players = universe();
  const sc = tierScarcity(players);
  assert.ok(sc.RB.remaining_in_tier >= 1);
  assert.equal(sc.RB.best_tier, 1);
});
