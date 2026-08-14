// Red-zone usage: nflverse play-by-play (free).
//
// The weekly stats file we already ingest has no field-position splits, so
// red-zone work has to come from the play-by-play file. That file is large
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
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { fetchWithRetry, saveSnapshot } from '../util.js';

const BASE = 'https://github.com/nflverse/nflverse-data/releases/download';
export const pbpUrl = year => `${BASE}/pbp/play_by_play_${year}.csv.gz`;

// Inside the 20 is the red zone; inside the 5 is the goal line, where the
// scoring rate per touch is far higher and the pecking order is tightest.
export const RED_ZONE = 20;
export const GOAL_LINE = 5;

const COLUMNS = ['season_type', 'week', 'posteam', 'yardline_100', 'two_point_attempt',
  'pass_attempt', 'rush_attempt', 'rush_touchdown', 'pass_touchdown',
  'rusher_player_id', 'receiver_player_id'];

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

const blank = () => ({ rz_targets: 0, rz_carries: 0, rz_tds: 0, gl_targets: 0, gl_carries: 0 });
const bucket = (map, key) => {
  if (!map.has(key)) map.set(key, new Map());
  return map.get(key);
};
function slot(map, key, week) {
  const weeks = bucket(map, key);
  if (!weeks.has(week)) weeks.set(week, blank());
  return weeks.get(week);
}

export function createAccumulator() {
  return { players: new Map(), teams: new Map(), weeks: new Set(), plays: 0, rzPlays: 0 };
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
  if (!(yard > 0 && yard <= RED_ZONE)) return acc;
  acc.rzPlays++;
  acc.weeks.add(week);

  const goalLine = yard <= GOAL_LINE;
  const team = p.posteam || null;
  const teamSlot = team ? slot(acc.teams, team, week) : null;

  if (isTarget) {
    const s = slot(acc.players, p.receiver_player_id, week);
    s.rz_targets++;
    if (goalLine) s.gl_targets++;
    if (p.pass_touchdown === '1') s.rz_tds++;
    if (teamSlot) { teamSlot.rz_targets++; if (goalLine) teamSlot.gl_targets++; }
  }
  if (isCarry) {
    const s = slot(acc.players, p.rusher_player_id, week);
    s.rz_carries++;
    if (goalLine) s.gl_carries++;
    if (p.rush_touchdown === '1') s.rz_tds++;
    if (teamSlot) { teamSlot.rz_carries++; if (goalLine) teamSlot.gl_carries++; }
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
    // Team totals come from every play in the game, not from our top-250
    // universe — so unlike the reconstructed target pie, red-zone shares
    // have a complete and exact denominator.
    teams: nest(acc.teams),
    players: nest(acc.players),
  };
}

// Stream the gzipped CSV, decoding incrementally so a multi-byte character
// split across chunk boundaries is not corrupted.
async function* streamLines(url) {
  const res = await fetchWithRetry(url, { timeoutMs: 300000 });
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

export async function ingestRedZone(year) {
  const url = pbpUrl(year);
  const acc = createAccumulator();
  let idx = null;

  for await (const line of streamLines(url)) {
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
      rusher_player_id: f[idx.rusher_player_id],
      receiver_player_id: f[idx.receiver_player_id],
    });
  }
  if (!idx) throw new Error(`nflverse pbp ${year}: empty file`);
  if (!acc.weeks.size) throw new Error(`nflverse pbp ${year}: no regular-season red-zone plays parsed`);

  const data = finalize(acc, year);
  saveSnapshot(`redzone_${year}.json`, data, {
    source: `nflverse play-by-play (${year}), reduced to red-zone usage`,
    url,
    kind: 'redzone',
    season: year,
    detail: `${acc.rzPlays} red-zone touches of ${acc.plays} scrimmage touches, ${data.weeks.length} weeks, ${Object.keys(data.players).length} players`,
    derived: 'Aggregated at ingest; the source play-by-play file is not retained.',
  });
  return { year, weeks: data.weeks.length, players: Object.keys(data.players).length, rz_touches: acc.rzPlays };
}
