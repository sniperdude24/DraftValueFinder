import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexSchedule, resultFor, byeWeeks } from '../src/normalize/schedules.js';

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
      // The opponent has ONE home on the row. `game_result` must not grow a
      // second copy: that duplication is what this de-duplication removed.
      else if ('opponent' in g.game_result) {
        mismatches.push(`${p.name} wk${g.week}: game_result carries a duplicate opponent`);
      }
    }
  }
  assert.ok(checked > 500, `expected a substantial sample, checked ${checked}`);
  assert.deepEqual(mismatches.slice(0, 10), [], `${mismatches.length} of ${checked} game rows disagree`);
});

// ---- bye weeks ----

const seasonRows = (missingByTeam = {}) => {
  // 4 teams, 3 weeks, round-robin-ish: enough to leave controlled gaps.
  const teams = ['ATL', 'BUF', 'CHI', 'LA'];
  const rows = [];
  for (let week = 1; week <= 3; week++) {
    for (let i = 0; i < teams.length; i += 2) {
      const home = teams[i], away = teams[i + 1];
      const skip = (missingByTeam[home] ?? []).includes(week) || (missingByTeam[away] ?? []).includes(week);
      if (skip) continue;
      rows.push({ game_id: `2026_${week}_${away}_${home}`, season: '2026', week: String(week),
        game_type: 'REG', home_team: home, away_team: away, home_score: '10', away_score: '7' });
    }
    teams.push(teams.shift());       // rotate so pairings vary
  }
  return rows;
};

test('a bye is the week a team has no fixture', () => {
  const byes = byeWeeks(seasonRows({ ATL: [2] }), 2026);
  assert.equal(byes.get('ATL'), 2);
});

test('byeWeeks normalizes team codes like the rest of the module', () => {
  // The schedule writes the Rams as "LA"; every other surface says "LAR".
  const byes = byeWeeks(seasonRows({ LA: [3] }), 2026);
  assert.equal(byes.get('LAR'), 3);
  assert.equal(byes.has('LA'), false, 'the raw code never escapes');
});

test('an incomplete schedule yields NO bye rather than guessing one', () => {
  // Two gaps means the fixtures are not fully published. Picking the first is
  // a guess dressed as a fact, and worse than deferring to the market value.
  const byes = byeWeeks(seasonRows({ ATL: [1, 3] }), 2026);
  assert.equal(byes.has('ATL'), false);
});

test('byeWeeks ignores other seasons and the postseason', () => {
  const rows = [
    ...seasonRows({ ATL: [2] }),
    { game_id: '2025_02_X_ATL', season: '2025', week: '2', game_type: 'REG', home_team: 'ATL', away_team: 'BUF', home_score: '1', away_score: '0' },
    { game_id: '2026_02_P_ATL', season: '2026', week: '2', game_type: 'POST', home_team: 'ATL', away_team: 'BUF', home_score: '1', away_score: '0' },
  ];
  assert.equal(byeWeeks(rows, 2026).get('ATL'), 2, 'neither the 2025 game nor the playoff game fills the bye');
});

test('every player bye agrees with the schedule', (t) => {
  const dbPath = join(ROOT, 'data', 'players.json');
  const csvPath = join(ROOT, 'data', 'raw', 'games.csv');
  if (!existsSync(dbPath) || !existsSync(csvPath)) return t.skip('database or schedule snapshot not built');

  const db = JSON.parse(readFileSync(dbPath, 'utf8'));
  const lines = readFileSync(csvPath, 'utf8').split(/\r?\n/);
  const header = lines[0].split(',');
  const rows = lines.slice(1).filter(Boolean).map(l => {
    const c = l.split(',');
    return Object.fromEntries(header.map((h, i) => [h, c[i]]));
  });
  const byes = byeWeeks(rows, db.season);
  assert.ok(byes.size >= 30, `expected a full league of byes, got ${byes.size}`);

  const mismatches = [];
  let checked = 0;
  for (const p of db.players) {
    const expected = p.team ? byes.get(p.team) : null;
    if (expected == null) continue;
    checked++;
    if (p.bye !== expected) mismatches.push(`${p.name} (${p.team}): stored ${p.bye} vs schedule ${expected}`);
  }
  assert.ok(checked > 200, `expected most of the universe, checked ${checked}`);
  assert.deepEqual(mismatches.slice(0, 10), [], `${mismatches.length} of ${checked} byes disagree`);
});
