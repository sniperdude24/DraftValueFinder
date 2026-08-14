// Per-player facts that only the play-by-play knows: red-zone usage, and
// touchdowns of 40+ yards.
//
// The weekly stats file we already ingest has no field-position splits, so
// red-zone work has to come from the play-by-play file. It also publishes
// plays of 40+ yards (`rushing_40` and friends) but not TOUCHDOWNS of 40+
// yards, which many leagues pay a bonus for — that distinction is what makes
// the second half of this reducer necessary. That file is large
// (~19 MB gzipped, ~93 MB of CSV, 372 columns), so it is never kept on disk
// and never fully materialized in memory: it is streamed, gunzipped, and
// reduced play-by-play into a small per-player / per-team weekly aggregate.
//
// COUNTING RULES — these were validated against nflverse's own weekly
// aggregation before being trusted: applied with no field-position filter,
// they reproduce the published season targets for all 502 targeted players
// and the carries for all 335 ball carriers, exactly. The red-zone numbers
// are the same rules restricted to a yardline, so they inherit that
// agreement rather than inventing a parallel definition.
//
//  - Regular season only.
//  - Two-point conversions are excluded (they are not scrimmage downs, and
//    nflverse excludes them too — including them broke the match above).
//  - A target is a pass attempt with a receiver on the play; sacks and
//    throwaways carry no receiver id and so are not targets.
//  - A carry is a rush attempt with a rusher (includes QB scrambles).
//  - A touchdown is credited to the rusher or receiver of the scoring play.
//  - A LONG touchdown is one whose play gained 40+ yards. A TD pass counts for
//    the passer AND the receiver, the way a league settings page treats them
//    as two separate bonuses. Long TDs are counted before the red-zone filter:
//    a 40-yard score starts outside the 20 by definition, so counting it
//    inside that branch would always produce zero.
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { fetchConditional, snapshotValidators, saveSnapshot } from '../util.js';

const BASE = 'https://github.com/nflverse/nflverse-data/releases/download';
export const pbpUrl = year => `${BASE}/pbp/play_by_play_${year}.csv.gz`;

// This snapshot is DERIVED at ingest rather than stored raw, so unlike the
// other sources it is not re-parsed from disk on every build. That makes a
// 304 dangerous in one specific way: if the counting rules below change,
// the cached output would silently stay on the old rules forever. Bumping
// this version forces a re-download and a re-reduction.
// Bump whenever accumulatePlay or finalize changes what they produce.
export const REDUCER_VERSION = 2;

// Inside the 20 is the red zone; inside the 5 is the goal line, where the
// scoring rate per touch is far higher and the pecking order is tightest.
export const RED_ZONE = 20;
export const GOAL_LINE = 5;

// The distance that makes a touchdown a "long" one for bonus purposes. This
// matches the threshold the weekly file's own `rushing_40` / `receiving_40` /
// `passing_40` columns use, which is what lets those columns act as an
// independent upper bound on what is counted here.
export const LONG_TD = 40;

const COLUMNS = ['season_type', 'week', 'posteam', 'yardline_100', 'two_point_attempt',
  'pass_attempt', 'rush_attempt', 'rush_touchdown', 'pass_touchdown',
  'yards_gained', 'passer_player_id', 'rusher_player_id', 'receiver_player_id'];

// Column order has changed across nflverse releases, so resolve indices from
// the header instead of hardcoding them.
export function resolveColumns(headerLine) {
  const cols = headerLine.replace(/\r$/, '').split(',');
  const idx = {};
  const missing = [];
  for (const name of COLUMNS) {
    const i = cols.indexOf(name);
    if (i < 0) missing.push(name); else idx[name] = i;
  }
  if (missing.length) throw new Error(`nflverse pbp: missing column(s) ${missing.join(', ')}`);
  return idx;
}

// Pull only the wanted columns out of one CSV line. Quote-aware because the
// play description field contains commas; building a 372-field array per
// play would allocate ~18M throwaway strings over a season.
export function pickFields(line, idx) {
  const wanted = new Set(Object.values(idx));
  const maxIdx = Math.max(...wanted);
  const out = [];
  let field = '', col = 0, inQ = false;
  for (let i = 0; i < line.length && col <= maxIdx; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') {
      inQ = true;
    } else if (c === ',') {
      if (wanted.has(col)) out[col] = field;
      field = ''; col++;
    } else field += c;
  }
  if (col <= maxIdx && wanted.has(col)) out[col] = field;
  return out;
}

// Players and teams carry different shapes on purpose: long-TD counts are a
// scoring input, which is a per-player notion. Giving team rows three fields
// that are never incremented would put permanent zeros on the record and
// invite someone to read them as a real team total.
const blankPlayer = () => ({
  rz_targets: 0, rz_carries: 0, rz_tds: 0, gl_targets: 0, gl_carries: 0,
  passing_40_tds: 0, rushing_40_tds: 0, receiving_40_tds: 0,
});
const blankTeam = () => ({ rz_targets: 0, rz_carries: 0, rz_tds: 0, gl_targets: 0, gl_carries: 0 });

const bucket = (map, key) => {
  if (!map.has(key)) map.set(key, new Map());
  return map.get(key);
};
function slot(map, key, week, blank) {
  const weeks = bucket(map, key);
  if (!weeks.has(week)) weeks.set(week, blank());
  return weeks.get(week);
}
const playerSlot = (acc, id, week) => slot(acc.players, id, week, blankPlayer);
const teamSlot = (acc, team, week) => slot(acc.teams, team, week, blankTeam);

export function createAccumulator() {
  return { players: new Map(), teams: new Map(), weeks: new Set(), plays: 0, rzPlays: 0, longTds: 0 };
}

// Fold one play into the accumulator. Pure and synchronous so the counting
// rules can be tested without touching the network.
export function accumulatePlay(acc, p) {
  if (p.season_type !== 'REG') return acc;
  if (p.two_point_attempt === '1') return acc;

  const yard = Number(p.yardline_100);
  const week = Number(p.week);
  if (!Number.isFinite(yard) || !Number.isFinite(week)) return acc;

  const isTarget = p.pass_attempt === '1' && !!p.receiver_player_id;
  const isCarry = p.rush_attempt === '1' && !!p.rusher_player_id;
  if (!isTarget && !isCarry) return acc;

  acc.plays++;
  // A week is "covered" if the source saw any scrimmage touch in it, which is
  // what lets build.js tell a genuine zero from an uncovered week. That has to
  // be recorded before the red-zone filter, or a long touchdown in a week with
  // no red-zone play would land in a week the build thinks it never saw.
  acc.weeks.add(week);

  // ---- long touchdowns (not field-position bounded) ----
  const gained = Number(p.yards_gained);
  if (Number.isFinite(gained) && gained >= LONG_TD) {
    if (isTarget && p.pass_touchdown === '1') {
      // Two separate bonuses in a league settings screen, so two counters:
      // the throw and the catch are credited independently.
      playerSlot(acc, p.receiver_player_id, week).receiving_40_tds++;
      if (p.passer_player_id) playerSlot(acc, p.passer_player_id, week).passing_40_tds++;
      acc.longTds++;
    }
    if (isCarry && p.rush_touchdown === '1') {
      playerSlot(acc, p.rusher_player_id, week).rushing_40_tds++;
      acc.longTds++;
    }
  }

  // ---- red zone ----
  if (!(yard > 0 && yard <= RED_ZONE)) return acc;
  acc.rzPlays++;

  const goalLine = yard <= GOAL_LINE;
  const team = p.posteam || null;
  const ts = team ? teamSlot(acc, team, week) : null;

  if (isTarget) {
    const s = playerSlot(acc, p.receiver_player_id, week);
    s.rz_targets++;
    if (goalLine) s.gl_targets++;
    if (p.pass_touchdown === '1') s.rz_tds++;
    if (ts) { ts.rz_targets++; if (goalLine) ts.gl_targets++; }
  }
  if (isCarry) {
    const s = playerSlot(acc, p.rusher_player_id, week);
    s.rz_carries++;
    if (goalLine) s.gl_carries++;
    if (p.rush_touchdown === '1') s.rz_tds++;
    if (ts) { ts.rz_carries++; if (goalLine) ts.gl_carries++; }
  }
  return acc;
}

const nest = map => Object.fromEntries(
  [...map].map(([key, weeks]) => [key, Object.fromEntries([...weeks].sort((a, b) => a[0] - b[0]))]));

export function finalize(acc, season) {
  return {
    season,
    weeks: [...acc.weeks].sort((a, b) => a - b),
    red_zone_yardline: RED_ZONE,
    goal_line_yardline: GOAL_LINE,
    long_td_yards: LONG_TD,
    // Team totals come from every play in the game, not from our top-250
    // universe — so unlike the reconstructed target pie, red-zone shares
    // have a complete and exact denominator.
    teams: nest(acc.teams),
    players: nest(acc.players),
  };
}

// Stream the gzipped CSV, decoding incrementally so a multi-byte character
// split across chunk boundaries is not corrupted.
async function* streamLines(res) {
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  for await (const chunk of Readable.fromWeb(res.body).pipe(createGunzip())) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      yield buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
    }
  }
  buf += decoder.decode();
  if (buf.trim() !== '') yield buf.replace(/\r$/, '');
}

export const pbpSnapshotName = year => `pbp_${year}.json`;

export async function ingestPbp(year, { force = false } = {}) {
  const url = pbpUrl(year);
  const name = pbpSnapshotName(year);

  // Validators are stored against the derived snapshot but describe the
  // play-by-play file it was reduced from.
  const prev = snapshotValidators(name);
  const staleReducer = !!prev && prev.reducer_version !== REDUCER_VERSION;
  const got = await fetchConditional(url, name, { force: force || staleReducer, timeoutMs: 300000 });
  // Nothing downloaded and nothing reduced — this is where the 19 MB goes.
  if (got.notModified) return { year, unchanged: true };

  const acc = createAccumulator();
  let idx = null;

  for await (const line of streamLines(got.res)) {
    if (!idx) { idx = resolveColumns(line); continue; }
    if (line === '') continue;
    const f = pickFields(line, idx);
    accumulatePlay(acc, {
      season_type: f[idx.season_type],
      week: f[idx.week],
      posteam: f[idx.posteam],
      yardline_100: f[idx.yardline_100],
      two_point_attempt: f[idx.two_point_attempt],
      pass_attempt: f[idx.pass_attempt],
      rush_attempt: f[idx.rush_attempt],
      rush_touchdown: f[idx.rush_touchdown],
      pass_touchdown: f[idx.pass_touchdown],
      yards_gained: f[idx.yards_gained],
      passer_player_id: f[idx.passer_player_id],
      rusher_player_id: f[idx.rusher_player_id],
      receiver_player_id: f[idx.receiver_player_id],
    });
  }
  if (!idx) throw new Error(`nflverse pbp ${year}: empty file`);
  if (!acc.weeks.size) throw new Error(`nflverse pbp ${year}: no regular-season scrimmage plays parsed`);

  const data = finalize(acc, year);
  saveSnapshot(name, data, {
    source: `nflverse play-by-play (${year}), reduced to red-zone usage and long touchdowns`,
    url,
    kind: 'pbp',
    season: year,
    reducer_version: REDUCER_VERSION,
    ...got.validators,
    detail: `${acc.rzPlays} red-zone touches and ${acc.longTds} touchdowns of ${LONG_TD}+ yards, of ${acc.plays} scrimmage touches; ${data.weeks.length} weeks, ${Object.keys(data.players).length} players`,
    derived: 'Aggregated at ingest; the source play-by-play file is not retained.',
  });
  return {
    year, weeks: data.weeks.length, players: Object.keys(data.players).length,
    rz_touches: acc.rzPlays, long_tds: acc.longTds,
  };
}
