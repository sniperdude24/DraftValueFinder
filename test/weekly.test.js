import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSit, fading, swaps, poolStatus, weeklyReport } from '../src/analyze/weekly.js';
import { applyFreeAgentList, defaultTeams, UNKNOWN_OWNER } from '../src/store/state.js';

const P = (id, position, projected, over = {}) => ({
  id, name: id, position, team: 'ATL', bye: 9,
  projection: projected == null ? null : { week: 3, pts_ppr: projected + 1, points: projected },
  games: [], ...over,
});

// A game log with a controllable snap/opportunity profile.
const games = (weeks, { snap, carries, targets, ppr }) => weeks.map((w, i) => ({
  week: w,
  snap_pct: Array.isArray(snap) ? snap[i] : snap,
  offense_snaps: 40,
  carries: Array.isArray(carries) ? carries[i] : carries,
  targets: Array.isArray(targets) ? targets[i] : targets,
  fantasy_points: Array.isArray(ppr) ? ppr[i] : ppr,
  fantasy_points_ppr: Array.isArray(ppr) ? ppr[i] : ppr,
}));

// ---- start / sit ----

test('the lineup is filled best-projection first', () => {
  const ss = startSit([P('rb_low', 'RB', 5), P('rb_high', 'RB', 20), P('qb', 'QB', 18)]);
  const rb1 = ss.lineup.find(s => s.slot === 'RB1');
  assert.equal(rb1.player.name, 'rb_high');
  assert.equal(ss.projected_total, 43);
});

test('a close call is surfaced as yours to make, not decided silently', () => {
  // 15.0 vs 14.0 in a single WR-eligible slot is not a real edge, and a page
  // that just prints the winner hides that.
  // Five receivers: three fill WR1-3, the fourth takes FLEX, the fifth sits.
  // Fewer than five and the bench is empty, so there is nothing to compare.
  const ss = startSit([
    P('wr_a', 'WR', 15), P('wr_b', 'WR', 14.5), P('wr_c', 'WR', 14.2),
    P('wr_d', 'WR', 14), P('wr_e', 'WR', 13.5),
  ]);
  assert.ok(ss.close_calls.length > 0, 'the bench receiver is within the margin');
  const call = ss.close_calls[0];
  assert.ok(call.margin <= 2);
  assert.ok(call.starting.projected >= call.alternative.projected, 'the better projection is the one starting');
});

test('a clear edge is not reported as a close call', () => {
  const ss = startSit([P('te_a', 'TE', 14), P('te_b', 'TE', 3)]);
  assert.deepEqual(ss.close_calls, []);
});

test('a player with no projection is named, not treated as zero', () => {
  const ss = startSit([P('rb_a', 'RB', 12), P('rb_x', 'RB', null)]);
  assert.deepEqual(ss.unprojected.map(p => p.name), ['rb_x']);
  assert.equal(ss.projected_total, 12, 'the missing projection contributes nothing');
});

test('an injured starter is flagged in the slot it occupies', () => {
  const ss = startSit([P('qb', 'QB', 20, { meta: { injury_status: 'Questionable' } })]);
  assert.ok(ss.flags.some(f => f.kind === 'injury' && f.text.includes('Questionable')));
  assert.ok(ss.flags.some(f => f.kind === 'empty_slot'), 'and the unfilled slots are named too');
});

// ---- fading ----

test('both snaps and opportunities falling is fading', () => {
  const p = P('rb', 'RB', 10, {
    stats_season: 2025,
    games: games([1, 2, 3, 4, 5, 6], {
      snap: [0.80, 0.80, 0.80, 0.55, 0.50, 0.48],
      carries: [18, 18, 18, 6, 5, 4], targets: 2, ppr: [16, 16, 16, 5, 4, 4],
    }),
  });
  const rows = fading([p]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'fading');
});

test('a points collapse with steady usage is NOISE, not a fading player', () => {
  // The most expensive mistake this page could talk someone into: dropping a
  // good player after two unlucky weeks. Usage is the evidence, points are not.
  const p = P('wr', 'WR', 10, {
    stats_season: 2025,
    games: games([1, 2, 3, 4, 5, 6], {
      snap: 0.85, carries: 0, targets: 9,
      ppr: [20, 22, 21, 4, 3, 5],           // points cratered, usage identical
    }),
  });
  const rows = fading([p]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'noise');
  assert.match(rows[0].reason, /variance, not a lost role/);
});

test('a steady player is not reported at all', () => {
  const p = P('wr', 'WR', 10, {
    stats_season: 2025,
    games: games([1, 2, 3, 4, 5, 6], { snap: 0.8, carries: 0, targets: 8, ppr: 14 }),
  });
  assert.deepEqual(fading([p]), []);
});

// ---- swaps ----

const assessMap = entries => new Map(entries.map(([id, state, rank]) =>
  [id, { signal: { state, reason: `${state} reason`, evidence: {}, context: [] }, ai_rank: rank, confidence: 70 }]));

test('a swap never pairs across positions', () => {
  const faded = [{ id: 'my_rb', name: 'my_rb', position: 'RB', state: 'fading', reason: 'x', evidence: {} }];
  const available = [P('fa_wr', 'WR', 12), P('fa_rb', 'RB', 11)];
  const out = swaps([], available, assessMap([['fa_wr', 'signal', 20], ['fa_rb', 'emerging', 60]]), faded);
  assert.equal(out.length, 1);
  assert.equal(out[0].add.position, 'RB', 'the RB is paired with the RB, not the better-ranked WR');
});

test('a signal outranks an emerging player at the same position', () => {
  const faded = [{ id: 'my_rb', name: 'my_rb', position: 'RB', state: 'fading', reason: 'x', evidence: {} }];
  const available = [P('rb_emerging', 'RB', 12), P('rb_signal', 'RB', 8)];
  const out = swaps([], available, assessMap([['rb_emerging', 'emerging', 20], ['rb_signal', 'signal', 90]]), faded);
  assert.equal(out[0].add.name, 'rb_signal');
});

test('a player flagged as noise never becomes a drop suggestion', () => {
  const faded = [{ id: 'my_wr', name: 'my_wr', position: 'WR', state: 'noise', reason: 'x', evidence: {} }];
  const available = [P('fa_wr', 'WR', 12)];
  assert.deepEqual(swaps([], available, assessMap([['fa_wr', 'signal', 10]]), faded), []);
});

test('no riser at the position means no suggestion, not a worse one', () => {
  const faded = [{ id: 'my_te', name: 'my_te', position: 'TE', state: 'fading', reason: 'x', evidence: {} }];
  const available = [P('fa_wr', 'WR', 12)];
  assert.deepEqual(swaps([], available, assessMap([['fa_wr', 'signal', 10]]), faded), []);
});

// ---- the pool ----

test('a never-pasted pool reports itself as unknown, not as "everyone is free"', () => {
  const s = poolStatus({ freeAgents: null });
  assert.equal(s.known, false);
  assert.equal(s.stale, true, 'unknown must behave as stale so the warning shows');
  assert.match(s.note, /does not know who is actually available/);
});

test('a pool older than a week is stale', () => {
  const state = applyFreeAgentList(
    { league: { teams: defaultTeams() }, owners: {}, picks: {} && [] }, ['a'],
    { now: new Date('2026-09-01T00:00:00Z') });
  assert.equal(poolStatus(state, Date.parse('2026-09-03T00:00:00Z')).stale, false);
  const old = poolStatus(state, Date.parse('2026-09-20T00:00:00Z'));
  assert.equal(old.stale, true);
  assert.match(old.note, /probably gone/);
});

// ---- the whole report ----

test('an empty roster produces an empty report rather than throwing', () => {
  const state = { league: { teams: defaultTeams() }, owners: {}, picks: [], mine: [], drafted: [], freeAgents: null };
  const r = weeklyReport([], new Map(), state, { mode: 'draft' });
  assert.equal(r.empty, true);
  assert.deepEqual(r.fading, []);
  assert.deepEqual(r.swaps, []);
  assert.equal(r.start_sit.projected_total, 0);
});

test('the report separates my players from the available pool', () => {
  const players = [P('mine1', 'RB', 15), P('taken1', 'RB', 12), P('free1', 'RB', 9)];
  const state = {
    league: { teams: defaultTeams() },
    owners: { mine1: 'team1', taken1: UNKNOWN_OWNER },
    picks: ['mine1', 'taken1'], mine: ['mine1'], drafted: ['mine1', 'taken1'], freeAgents: null,
  };
  const r = weeklyReport(players, new Map(), state, { mode: 'season', week: 4 });
  assert.equal(r.available_count, 1, 'only free1 has no owner');
  assert.equal(r.start_sit.lineup.find(s => s.slot === 'RB1').player.name, 'mine1');
});
