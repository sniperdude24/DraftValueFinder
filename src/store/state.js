// Draft state + personal ranking overrides, persisted to data/state.json.
// The user's personal ranks are sacred: the AI never modifies them.
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../ingest/util.js';

const STATE_PATH = join(ROOT, 'data', 'state.json');

// `scoring` holds a preset name, or 'custom' plus a full rule set. loadState
// spreads DEFAULT underneath the saved object, so a state.json written
// before scoring existed picks up PPR without needing a migration step.
const DEFAULT = { drafted: [], mine: [], personalRanks: {}, scoring: { preset: 'ppr', rules: null } };

export function loadState() {
  if (!existsSync(STATE_PATH)) return structuredClone(DEFAULT);
  try {
    return { ...structuredClone(DEFAULT), ...JSON.parse(readFileSync(STATE_PATH, 'utf8')) };
  } catch {
    return structuredClone(DEFAULT);
  }
}

export function saveState(state) {
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  const tmp = STATE_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 1));
  renameSync(tmp, STATE_PATH);
}

export function markDrafted(state, id, { mine = false } = {}) {
  if (!state.drafted.includes(id)) state.drafted.push(id);
  if (mine && !state.mine.includes(id)) state.mine.push(id);
  if (!mine) state.mine = state.mine.filter(x => x !== id);
  return state;
}

export function undoDraft(state, id) {
  state.drafted = state.drafted.filter(x => x !== id);
  state.mine = state.mine.filter(x => x !== id);
  return state;
}

export function setPersonalRank(state, id, rank) {
  if (rank == null) delete state.personalRanks[id];
  else state.personalRanks[id] = rank;
  return state;
}
