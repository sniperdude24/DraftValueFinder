import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTeamContext, teamWeeklyTargets, teamSummaries } from '../src/analyze/teamContext.js';

// A player with per-week lines: [week, team, targets, target_share, carries]
function player(id, position, team, lines, extra = {}) {
  return {
    id, name: id, position, team,
    stats_team: lines.length ? lines[lines.length - 1][1] : null,
    meta: { injury_status: null }, ...extra,
    games: lines.map(([week, stats_team, targets, target_share, carries = 0]) => ({
      week, stats_team, targets, target_share, carries,
      receiving_air_yards: 0, fantasy_points_ppr: targets * 1.5 + carries,
    })),
  };
}

test('team weekly targets are reconstructed from targets ÷ target share', () => {
  // Two players agree the team threw 40 times in week 1.
  const players = [
    player('WR-a', 'WR', 'KC', [[1, 'KC', 10, 0.25]]),
    player('WR-b', 'WR', 'KC', [[1, 'KC', 8, 0.20]]),
  ];
  assert.equal(teamWeeklyTargets(players, 'KC').get(1), 40);
});

test('median absorbs rounding noise in the published share', () => {
  const players = [
    player('WR-a', 'WR', 'KC', [[1, 'KC', 10, 0.250]]),   // 40.0
    player('WR-b', 'WR', 'KC', [[1, 'KC', 7, 0.176]]),    // 39.8 (rounded share)
    player('WR-c', 'WR', 'KC', [[1, 'KC', 5, 0.124]]),    // 40.3
  ];
  const est = teamWeeklyTargets(players, 'KC').get(1);
  assert.ok(Math.abs(est - 40) < 0.5, `expected ~40, got ${est}`);
});

test('shares come from window totals, so missed games reduce a player\'s share', () => {
  // Team throws 40/week for 2 weeks (80 total). A plays both (20 targets),
  // B plays one (10 targets). A = 25%, B = 12.5% — not 25% each.
  const players = [
    player('WR-a', 'WR', 'KC', [[1, 'KC', 10, 0.25], [2, 'KC', 10, 0.25]]),
    player('WR-b', 'WR', 'KC', [[2, 'KC', 10, 0.25]]),
  ];
  const ctx = buildTeamContext(players, 'KC');
  const a = ctx.season.rows.find(r => r.id === 'WR-a');
  const b = ctx.season.rows.find(r => r.id === 'WR-b');
  assert.equal(a.target_share, 0.25);
  assert.equal(b.target_share, 0.125);
});

test('mid-season trade: only games played for the team count toward its pie', () => {
  const players = [
    player('WR-a', 'WR', 'KC', [[1, 'KC', 10, 0.25], [2, 'KC', 10, 0.25]]),
    // Traded away: week 1 in KC, week 2 elsewhere. Only week 1 counts for KC.
    player('WR-t', 'WR', 'NYJ', [[1, 'KC', 8, 0.20], [2, 'NYJ', 9, 0.30]]),
  ];
  const ctx = buildTeamContext(players, 'KC');
  const traded = ctx.season.rows.find(r => r.id === 'WR-t');
  assert.equal(traded.targets, 8, 'only the KC game counts');
  assert.equal(traded.games, 1);
  assert.equal(traded.still_on_team, false);
});

test('unaccounted share is reported rather than hidden', () => {
  // One tracked player with 25% of a 40-target offense; the rest is untracked.
  const players = [player('WR-a', 'WR', 'KC', [[1, 'KC', 10, 0.25]])];
  const ctx = buildTeamContext(players, 'KC');
  assert.equal(ctx.season.accounted_target_share, 0.25);
  assert.ok(ctx.season.accounted_target_share < 1);
});

test('departed players surface as vacated opportunity', () => {
  const players = [
    player('WR-stay', 'WR', 'KC', [[1, 'KC', 10, 0.25]]),
    player('WR-gone', 'WR', 'NYJ', [[1, 'KC', 12, 0.30], [1, 'KC', 0, 0, 0]].slice(0, 1)),
    player('RB-gone', 'RB', 'DEN', [[1, 'KC', 2, 0.05, 15]]),
  ];
  const ctx = buildTeamContext(players, 'KC');
  const names = ctx.roster_changes.departed.map(d => d.id).sort();
  assert.deepEqual(names, ['RB-gone', 'WR-gone']);
  assert.equal(ctx.roster_changes.vacated_carries, 15);
  assert.ok(ctx.roster_changes.vacated_target_share > 0.3);
  assert.equal(ctx.roster_changes.departed.find(d => d.id === 'WR-gone').now_with, 'NYJ');
});

test('arrivals with no games for this team are listed separately', () => {
  const players = [
    player('WR-a', 'WR', 'KC', [[1, 'KC', 10, 0.25]]),
    player('WR-new', 'WR', 'KC', [[1, 'DEN', 9, 0.22]]),
  ];
  const ctx = buildTeamContext(players, 'KC');
  assert.deepEqual(ctx.roster_changes.arrived.map(a => a.id), ['WR-new']);
  assert.equal(ctx.roster_changes.arrived[0].came_from, 'DEN');
});

test('ripple pairs an injured player with teammates whose share rose, never himself', () => {
  // 4 weeks. WR-hurt fades, WR-up climbs. Team throws 40/week throughout.
  const players = [
    player('WR-hurt', 'WR', 'KC', [[1, 'KC', 12, 0.30], [2, 'KC', 12, 0.30], [3, 'KC', 2, 0.05], [4, 'KC', 0, 0]],
      { meta: { injury_status: 'Out' } }),
    player('WR-up', 'WR', 'KC', [[1, 'KC', 4, 0.10], [2, 'KC', 4, 0.10], [3, 'KC', 14, 0.35], [4, 'KC', 16, 0.40]]),
    player('WR-flat', 'WR', 'KC', [[1, 'KC', 8, 0.20], [2, 'KC', 8, 0.20], [3, 'KC', 8, 0.20], [4, 'KC', 8, 0.20]]),
  ];
  const ctx = buildTeamContext(players, 'KC');
  const link = ctx.ripple.find(r => r.disrupted.id === 'WR-hurt');
  assert.ok(link, 'the injured player must produce a ripple entry');
  assert.match(link.disrupted.reason, /Out/);
  const ids = link.beneficiaries.map(b => b.id);
  assert.ok(ids.includes('WR-up'), 'the rising teammate is surfaced');
  assert.ok(!ids.includes('WR-hurt'), 'a player is never his own beneficiary');
  assert.ok(!ids.includes('WR-flat'), 'flat usage is not a beneficiary');
});

test('carry share is computed from tracked carries and labeled as such', () => {
  const players = [
    player('RB-a', 'RB', 'KC', [[1, 'KC', 2, 0.05, 15]]),
    player('RB-b', 'RB', 'KC', [[1, 'KC', 1, 0.03, 5]]),
  ];
  const ctx = buildTeamContext(players, 'KC');
  assert.equal(ctx.season.tracked_carries, 20);
  assert.equal(ctx.season.rows.find(r => r.id === 'RB-a').carry_share, 0.75);
});

test('teamSummaries counts roster, injuries and incoming players', () => {
  const players = [
    player('WR-a', 'WR', 'KC', [[1, 'KC', 5, 0.2]]),
    player('WR-b', 'WR', 'KC', [[1, 'DEN', 5, 0.2]], { changed_team: true }),
    player('WR-c', 'WR', 'KC', [[1, 'KC', 5, 0.2]], { meta: { injury_status: 'IR' } }),
    player('WR-d', 'WR', 'NYJ', [[1, 'NYJ', 5, 0.2]]),
  ];
  const s = teamSummaries(players);
  const kc = s.find(t => t.team === 'KC');
  assert.equal(kc.players, 3);
  assert.equal(kc.injured, 1);
  assert.equal(kc.incoming, 1);
  assert.deepEqual(s.map(t => t.team), ['KC', 'NYJ']);
});

test('a team with no data does not throw', () => {
  const ctx = buildTeamContext([player('WR-a', 'WR', 'KC', [[1, 'KC', 5, 0.2]])], 'SEA');
  assert.equal(ctx.games, 0);
  assert.deepEqual(ctx.season.rows, []);
  assert.equal(ctx.season.accounted_target_share, null);
});
