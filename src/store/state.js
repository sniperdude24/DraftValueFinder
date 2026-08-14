// League rosters + personal ranking overrides, persisted to data/state.json.
// The user's personal ranks are sacred: the AI never modifies them.
//
// OWNERSHIP MODEL
// `owners` is canonical: it maps a player id to the league team that holds
// them. `picks` keeps draft order, which is what pick numbers and the roster
// sidebar's round chips are built from.
//
// `drafted` and `mine` are DERIVED on load, never stored. Around twenty call
// sites across the server, the recommendation engine, the chat context and
// the database build read those two arrays, and they keep working untouched;
// but persisting them alongside `owners` would give the same fact two homes
// and let them drift. saveState strips them on the way out.
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../ingest/util.js';

const STATE_PATH = join(ROOT, 'data', 'state.json');

// A player known to be taken whose team we genuinely don't know — the honest
// result of migrating a binary drafted/mine flag, which never recorded who
// took anyone. Displayed as "Taken — owner unknown", never guessed at.
export const UNKNOWN_OWNER = 'unknown';

export const DEFAULT_TEAM_COUNT = 10;

export function defaultTeams(count = DEFAULT_TEAM_COUNT) {
  return Array.from({ length: count }, (_, i) => ({
    id: `team${i + 1}`,
    name: i === 0 ? 'My Team' : `Team ${i + 1}`,
    mine: i === 0,
  }));
}

const DEFAULT = () => ({
  league: { teams: defaultTeams() },
  owners: {},
  picks: [],
  personalRanks: {},
  scoring: { preset: 'ppr', rules: null },
});

export function myTeamId(state) {
  return state.league?.teams?.find(t => t.mine)?.id ?? null;
}

// Is this id a real league team (as opposed to the unknown-owner sentinel)?
const isTeam = (state, id) => (state.league?.teams ?? []).some(t => t.id === id);

// Rebuild the legacy views from the canonical model. Order follows `picks`
// so pick numbers stay stable; anything owned but never picked (assigned
// directly rather than drafted) is appended.
function derive(state) {
  const owned = Object.keys(state.owners ?? {});
  const ordered = (state.picks ?? []).filter(id => state.owners?.[id] != null);
  for (const id of owned) if (!ordered.includes(id)) ordered.push(id);
  const me = myTeamId(state);
  state.drafted = ordered;
  state.mine = ordered.filter(id => state.owners[id] === me);
  return state;
}

// A state written before the owner model existed carries `drafted`/`mine`
// and no `owners`. Convert it rather than dropping it — this is real user
// data (rosters that took a draft to build).
//
// This MUST run on the parsed file before defaults are merged in: DEFAULT()
// supplies an empty `owners` object, which is truthy, so a post-merge check
// would read every legacy file as already migrated and quietly discard the
// roster it was supposed to preserve.
export function migrate(raw) {
  if (raw.owners) return raw;
  const league = raw.league ?? { teams: defaultTeams() };
  const me = league.teams.find(t => t.mine)?.id ?? league.teams[0]?.id;
  const owners = {};
  const picks = [...(raw.drafted ?? [])];
  for (const id of picks) {
    // Whether a non-mine pick belonged to team 3 or team 7 was never
    // recorded, so it cannot be recovered — mark it unknown and let the
    // League page ask, instead of fabricating an owner.
    owners[id] = (raw.mine ?? []).includes(id) ? me : UNKNOWN_OWNER;
  }
  return { ...raw, league, owners, picks };
}

export function loadState() {
  if (!existsSync(STATE_PATH)) return derive(DEFAULT());
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    return derive({ ...DEFAULT(), ...migrate(raw) });
  } catch {
    return derive(DEFAULT());
  }
}

// What actually reaches disk: the derived views are stripped so `owners`
// and `picks` remain the only record of who holds whom. Exported so the
// no-drift rule can be asserted without writing to the real state file.
export function toPersisted(state) {
  const { drafted, mine, ...persist } = state;
  return persist;
}

export function saveState(state) {
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  const tmp = STATE_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(toPersisted(state), null, 1));
  renameSync(tmp, STATE_PATH);
}

// ---- writers ----

// teamId null/undefined frees the player. Passing UNKNOWN_OWNER records
// "taken, owner unknown", which is a real state and not the same as free.
export function setOwner(state, id, teamId) {
  state.owners ??= {};
  state.picks ??= [];
  if (teamId == null) {
    delete state.owners[id];
    state.picks = state.picks.filter(x => x !== id);
  } else {
    if (teamId !== UNKNOWN_OWNER && !isTeam(state, teamId)) {
      throw new Error(`unknown team "${teamId}"`);
    }
    state.owners[id] = teamId;
    // First assignment joins the draft order; a later change of owner keeps
    // the original position, so pick numbers don't shuffle when a mistake
    // is corrected.
    if (!state.picks.includes(id)) state.picks.push(id);
  }
  return derive(state);
}

export function markDrafted(state, id, { mine = false } = {}) {
  return setOwner(state, id, mine ? myTeamId(state) : UNKNOWN_OWNER);
}

export function undoDraft(state, id) {
  return setOwner(state, id, null);
}

export function setTeams(state, teams) {
  const clean = teams.map((t, i) => ({
    id: t.id ?? `team${i + 1}`,
    name: String(t.name ?? `Team ${i + 1}`).slice(0, 40).trim() || `Team ${i + 1}`,
    mine: !!t.mine,
  }));
  // Exactly one team is mine — the roster sidebar, My Team page and every
  // roster-aware recommendation depend on that being unambiguous.
  if (!clean.some(t => t.mine) && clean.length) clean[0].mine = true;
  let seen = false;
  for (const t of clean) {
    if (t.mine && seen) t.mine = false;
    if (t.mine) seen = true;
  }
  state.league = { ...state.league, teams: clean };
  // Drop ownership pointing at teams that no longer exist rather than
  // leaving players owned by a ghost.
  for (const [id, owner] of Object.entries(state.owners ?? {})) {
    if (owner !== UNKNOWN_OWNER && !isTeam(state, owner)) delete state.owners[id];
  }
  state.picks = (state.picks ?? []).filter(id => state.owners?.[id] != null);
  return derive(state);
}

export function clearRosters(state, { teamId = null } = {}) {
  if (teamId == null) {
    state.owners = {};
    state.picks = [];
  } else {
    for (const [id, owner] of Object.entries(state.owners ?? {})) {
      if (owner === teamId) delete state.owners[id];
    }
    state.picks = (state.picks ?? []).filter(id => state.owners[id] != null);
  }
  return derive(state);
}

export function setPersonalRank(state, id, rank) {
  if (rank == null) delete state.personalRanks[id];
  else state.personalRanks[id] = rank;
  return state;
}
