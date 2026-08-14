import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexSchedule, resultFor } from '../src/normalize/schedules.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const rows = [
  { game_id: '2025_17_LA_ATL', season: '2025', week: '17', game_type: 'REG',
    home_team: 'ATL', away_team: 'LA', home_score: '27', away_score: '24' },
  { game_id: '2025_16_ATL_ARI', season: '2025', week: '16', game_type: 'REG',
    home_team: 'ARI', away_team: 'ATL', home_score: '19', away_score: '26' },
  { game_id: '2025_10_AAA_BBB', season: '2025', week: '10', game_type: 'REG',
    home_team: 'CHI', away_team: 'GB', home_score: '17', away_score: '17' },
  { game_id: '2026_01_KC_BUF', season: '2026', week: '1', game_type: 'REG',
    home_team: 'BUF', away_team: 'KC', home_score: '', away_score: '' },
];
const index = indexSchedule(rows);

test('a home team reads its own score first', () => {
  const r = resultFor(index, '2025_17_LA_ATL', 'ATL');
  assert.equal(r.at, false);
  assert.equal(r.opponent, 'LAR');
  assert.equal(r.outcome, 'W');
  assert.equal(r.team_score, 27);
  assert.equal(r.opp_score, 24);
});

test('an away team is not given the home team\'s result', () => {
  // The failure this guards is silent: assuming the player's team is home
  // produces a complete, plausible line with the score the wrong way round.
  const r = resultFor(index, '2025_16_ATL_ARI', 'ATL');
  assert.equal(r.at, true, 'ATL was the away team');
  assert.equal(r.opponent, 'ARI');
  assert.equal(r.team_score, 26);
  assert.equal(r.opp_score, 19);
  assert.equal(r.outcome, 'W');
});

test('the Rams normalize on both sides of the join', () => {
  // The schedules file writes "LA"; the rest of the app says "LAR". Left
  // unnormalized this is the bug that rendered an empty LAR page once before.
  assert.equal(resultFor(index, '2025_17_LA_ATL', 'ATL').opponent, 'LAR');
  const asRams = resultFor(index, '2025_17_LA_ATL', 'LA');
  assert.equal(asRams.opponent, 'ATL');
  assert.equal(asRams.outcome, 'L');
  assert.deepEqual(resultFor(index, '2025_17_LA_ATL', 'LAR'), asRams,
    'either spelling of the Rams resolves to the same game');
});

test('a tie is a tie, not a loss', () => {
  assert.equal(resultFor(index, '2025_10_AAA_BBB', 'CHI').outcome, 'T');
});

test('an unknown game id yields null, never a 0-0 game', () => {
  assert.equal(resultFor(index, '2099_01_XXX_YYY', 'CHI'), null);
  assert.equal(resultFor(index, undefined, 'CHI'), null);
});

test('a scheduled game with no final score yields null', () => {
  // A game not yet played and a genuine shutout are different facts.
  assert.equal(resultFor(index, '2026_01_KC_BUF', 'KC'), null);
});

test('a team that did not play in the game yields null', () => {
  // If the join ever goes wrong, saying nothing is right; reporting the home
  // side's result would be a confident lie.
  assert.equal(resultFor(index, '2025_17_LA_ATL', 'DAL'), null);
});

// ---- the real-data check ----

test('every stored game row agrees with the schedule snapshot', (t) => {
  const dbPath = join(ROOT, 'data', 'players.json');
  const csvPath = join(ROOT, 'data', 'raw', 'games.csv');
  if (!existsSync(dbPath) || !existsSync(csvPath)) return t.skip('database or schedule snapshot not built');

  const db = JSON.parse(readFileSync(dbPath, 'utf8'));
  const lines = readFileSync(csvPath, 'utf8').split(/\r?\n/);
  const header = lines[0].split(',');
  const col = name => header.indexOf(name);
  const sched = new Map();
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const c = line.split(',');
    sched.set(c[col('game_id')], { home: c[col('home_team')], away: c[col('away_team')] });
  }

  let checked = 0;
  const mismatches = [];
  for (const p of db.players) {
    for (const g of p.games ?? []) {
      const s = sched.get(g.game_id);
      if (!s) { mismatches.push(`${p.name} wk${g.week}: game_id ${g.game_id} not in schedule`); continue; }
      checked++;
      // Compare against the raw file's own two team codes, so a normalization
      // that dropped a team on the floor shows up here.
      const other = [s.home, s.away].find(t => t !== (g.stats_team === 'LAR' ? 'LA' : g.stats_team));
      const expected = other === 'LA' ? 'LAR' : other;
      if (g.opponent !== expected) mismatches.push(`${p.name} wk${g.week}: opponent ${g.opponent} vs schedule ${expected}`);
      if (!g.game_result) mismatches.push(`${p.name} wk${g.week}: no result for a completed game`);
      else if (g.game_result.opponent !== g.opponent) {
        mismatches.push(`${p.name} wk${g.week}: result opponent ${g.game_result.opponent} != row opponent ${g.opponent}`);
      }
    }
  }
  assert.ok(checked > 500, `expected a substantial sample, checked ${checked}`);
  assert.deepEqual(mismatches.slice(0, 10), [], `${mismatches.length} of ${checked} game rows disagree`);
});
