import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numbered, flattenAttrs, extractDraftResults, extractPlayers, extractLeagues } from '../src/yahoo/client.js';
import { buildPlayerIndex, mapPicksToState, draftComplete } from '../src/yahoo/sync.js';

// ---- fantasy_content shape helpers ----

test('numbered unwraps count-keyed collections in order', () => {
  assert.deepEqual(numbered({ count: 2, 1: 'b', 0: 'a' }), ['a', 'b']);
  assert.deepEqual(numbered(null), []);
});

test('flattenAttrs merges Yahoo attribute arrays, skipping stray arrays', () => {
  assert.deepEqual(flattenAttrs([{ a: 1 }, [], { b: 2 }]), { a: 1, b: 2 });
});

test('extractDraftResults parses picks, drops empty upcoming slots, sorts by pick', () => {
  const payload = { fantasy_content: { league: [{ league_key: 'x' }, { draft_results: {
    count: 3,
    0: { draft_result: { pick: '2', round: '1', team_key: 't.2', player_key: 'p.20' } },
    1: { draft_result: { pick: '1', round: '1', team_key: 't.1', player_key: 'p.10' } },
    2: { draft_result: { pick: '3', round: '1', team_key: 't.3' } }, // no player yet
  } }] } };
  const picks = extractDraftResults(payload);
  assert.deepEqual(picks.map(p => p.pick), [1, 2]);
  assert.equal(picks[0].player_key, 'p.10');
});

test('extractPlayers flattens player attribute arrays', () => {
  const payload = { fantasy_content: { league: [{}, { players: {
    count: 1,
    0: { player: [[{ player_key: 'p.10' }, { name: { full: "Ja'Marr Chase" } }, { display_position: 'WR' }, { editorial_team_abbr: 'Cin' }]] },
  } }] } };
  const players = extractPlayers(payload);
  assert.equal(players.length, 1);
  assert.equal(players[0].name, "Ja'Marr Chase");
  assert.equal(players[0].position, 'WR');
});

test('extractLeagues walks users→games→leagues', () => {
  const payload = { fantasy_content: { users: { count: 1, 0: { user: [{}, { games: { count: 1, 0: { game: [{}, { leagues: {
    count: 1, 0: { league: [{ league_key: '461.l.123', name: 'Boise Bros', num_teams: '10', draft_status: 'predraft' }] },
  } }] } } }] } } } };
  const leagues = extractLeagues(payload);
  assert.equal(leagues[0].league_key, '461.l.123');
  assert.equal(leagues[0].num_teams, 10);
});

// ---- pick mapping (the sync core) ----

const ourPlayers = [
  { id: 'WR-jamarr_chase', name: "Ja'Marr Chase", position: 'WR' },
  { id: 'RB-kenneth_walker', name: 'Kenneth Walker III', position: 'RB' },
  { id: 'WR-travis_hunter', name: 'Travis Hunter', position: 'WR' },
];

function pick(pickNo, teamKey, playerKey) {
  return { pick: pickNo, round: Math.ceil(pickNo / 10), team_key: teamKey, player_key: playerKey };
}

test('maps Yahoo picks to our IDs across name/position variants', () => {
  const index = buildPlayerIndex(ourPlayers);
  const picks = [pick(1, 't.5', 'p.1'), pick(2, 't.9', 'p.2'), pick(3, 't.5', 'p.3')];
  const yahooPlayers = [
    { player_key: 'p.1', name: 'Jamarr Chase', position: 'WR' },          // punctuation variant
    { player_key: 'p.2', name: 'Kenneth Walker', position: 'RB' },         // suffix dropped
    { player_key: 'p.3', name: 'Travis Hunter', position: 'WR,CB' },       // multi-position
  ];
  const r = mapPicksToState(picks, yahooPlayers, 't.5', index);
  assert.deepEqual(r.drafted, ['WR-jamarr_chase', 'RB-kenneth_walker', 'WR-travis_hunter']);
  assert.deepEqual(r.mine, ['WR-jamarr_chase', 'WR-travis_hunter']);
  assert.equal(r.unmatched.length, 0);
});

test('players outside our universe are surfaced as unmatched, never dropped', () => {
  const index = buildPlayerIndex(ourPlayers);
  const picks = [pick(1, 't.5', 'p.1'), pick(2, 't.5', 'p.99')];
  const yahooPlayers = [
    { player_key: 'p.1', name: "Ja'Marr Chase", position: 'WR' },
    { player_key: 'p.99', name: 'Deep Benchguy', position: 'TE' },
  ];
  const r = mapPicksToState(picks, yahooPlayers, 't.5', index);
  assert.equal(r.drafted.length, 1);
  assert.equal(r.unmatched.length, 1);
  assert.equal(r.unmatched[0].name, 'Deep Benchguy');
  assert.equal(r.unmatched[0].mine, true);
});

test('pick order is preserved in drafted list (round badges depend on it)', () => {
  const index = buildPlayerIndex(ourPlayers);
  const picks = [pick(1, 't.1', 'p.2'), pick(2, 't.2', 'p.1')];
  const yahooPlayers = [
    { player_key: 'p.1', name: "Ja'Marr Chase", position: 'WR' },
    { player_key: 'p.2', name: 'Kenneth Walker III', position: 'RB' },
  ];
  const r = mapPicksToState(picks, yahooPlayers, 't.9', index);
  assert.deepEqual(r.drafted, ['RB-kenneth_walker', 'WR-jamarr_chase']);
  assert.equal(r.mine.length, 0);
});

test('ambiguous name-only matches are not guessed', () => {
  const two = [
    { id: 'WR-josh_smith', name: 'Josh Smith', position: 'WR' },
    { id: 'TE-josh_smith', name: 'Josh Smith', position: 'TE' },
  ];
  const index = buildPlayerIndex(two);
  // Yahoo lists him at a position we don't have him at → name-only lookup
  // hits two candidates → must go to unmatched rather than guessing.
  const r = mapPicksToState([pick(1, 't.1', 'p.1')], [{ player_key: 'p.1', name: 'Josh Smith', position: 'QB' }], 't.9', index);
  assert.equal(r.drafted.length, 0);
  assert.equal(r.unmatched.length, 1);
});

test('multi-position listing resolves via primary position even when the name is ambiguous', () => {
  const two = [
    { id: 'WR-josh_smith', name: 'Josh Smith', position: 'WR' },
    { id: 'TE-josh_smith', name: 'Josh Smith', position: 'TE' },
  ];
  const index = buildPlayerIndex(two);
  // Name-only lookup is ambiguous here, so only the "WR,KR" -> WR primary-
  // position split can resolve this pick.
  const r = mapPicksToState([pick(1, 't.1', 'p.1')], [{ player_key: 'p.1', name: 'Josh Smith', position: 'WR,KR' }], 't.9', index);
  assert.deepEqual(r.drafted, ['WR-josh_smith']);
});

test('draftComplete stops autosync at teams × rounds', () => {
  assert.equal(draftComplete(149, 10, 15), false);
  assert.equal(draftComplete(150, 10, 15), true);
});
