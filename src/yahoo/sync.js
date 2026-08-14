// Yahoo draft sync: poll draftresults during a live draft and mirror the
// picks into the app's draft state — replacing manual clicking.
//
// mapPicksToState is pure and fully unit-tested; syncOnce orchestrates.
import { yahooApi } from './client.js';
import { nameKey, normPosition } from '../normalize/names.js';
import { loadState, saveState, setOwner, clearRosters, myTeamId, UNKNOWN_OWNER } from '../store/state.js';
import { logEvent } from '../store/history.js';
import { LEAGUE } from '../analyze/roster.js';

// Build a lookup from our player database: nameKey+position group -> id,
// with a name-only fallback for cross-source position disagreements.
export function buildPlayerIndex(players) {
  const byNamePos = new Map();
  const byName = new Map();
  for (const p of players) {
    byNamePos.set(`${normPosition(p.position)}|${nameKey(p.name)}`, p.id);
    const nk = nameKey(p.name);
    // Name-only entries are only safe while unambiguous.
    byName.set(nk, byName.has(nk) ? null : p.id);
  }
  return { byNamePos, byName };
}

// Pure: Yahoo picks + Yahoo player metadata -> our draft state shape.
// Unmatched picks (players outside our top-250 universe, or name-matching
// gaps) are surfaced, never silently dropped.
export function mapPicksToState(picks, yahooPlayers, myTeamKey, playerIndex) {
  const metaByKey = new Map(yahooPlayers.map(p => [p.player_key, p]));
  const drafted = [];
  const mine = [];
  const unmatched = [];
  for (const pick of picks) {
    const meta = metaByKey.get(pick.player_key);
    const yahooPos = normPosition((meta?.position ?? '').split(',')[0]); // "WR,TE" -> WR
    const id = meta?.name
      ? (playerIndex.byNamePos.get(`${yahooPos}|${nameKey(meta.name)}`) ?? playerIndex.byName.get(nameKey(meta.name)) ?? null)
      : null;
    if (id) {
      drafted.push(id);
      if (pick.team_key === myTeamKey) mine.push(id);
    } else {
      unmatched.push({ pick: pick.pick, round: pick.round, name: meta?.name ?? pick.player_key, position: meta?.position ?? '?', mine: pick.team_key === myTeamKey });
    }
  }
  return { drafted, mine, unmatched };
}

export function draftComplete(pickCount, numTeams = LEAGUE.teams, rounds = LEAGUE.rounds) {
  return pickCount >= numTeams * rounds;
}

// One full sync cycle. Returns a status summary for the UI.
export async function syncOnce(db) {
  const state = loadState();
  const { league_key, team_key } = state.yahoo ?? {};
  if (!league_key) throw new Error('No Yahoo league selected');

  const picks = await yahooApi.draftResults(league_key);
  const keys = [...new Set(picks.map(p => p.player_key))];
  const yahooPlayers = keys.length ? await yahooApi.playersByKeys(league_key, keys) : [];
  const index = buildPlayerIndex(db.players);
  const mapped = mapPicksToState(picks, yahooPlayers, team_key, index);

  // Yahoo is the source of truth for pick state; personal ranks untouched.
  // Route through the owner model rather than assigning the derived arrays.
  // Picks belonging to other managers land as owner-unknown until the League
  // page names them — mapping Yahoo's own team keys onto our league teams is
  // a separate job, and guessing would be worse than asking.
  clearRosters(state);
  const mineSet = new Set(mapped.mine);
  for (const id of mapped.drafted) {
    setOwner(state, id, mineSet.has(id) ? myTeamId(state) : UNKNOWN_OWNER);
  }
  state.yahoo = { ...state.yahoo, last_sync: new Date().toISOString(), unmatched: mapped.unmatched, pick_count: picks.length };
  saveState(state);
  logEvent({ trigger: 'draft_sync', picks: picks.length, matched: mapped.drafted.length, unmatched: mapped.unmatched.length });
  return { picks: picks.length, matched: mapped.drafted.length, mine: mapped.mine.length, unmatched: mapped.unmatched, complete: draftComplete(picks.length) };
}
