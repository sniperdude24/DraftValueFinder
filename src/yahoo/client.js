// Yahoo Fantasy v2 API client + extractors for its fantasy_content JSON.
//
// Yahoo's JSON is XML-shaped: collections are objects with numeric string
// keys plus a "count", and entities are arrays of single-key attribute
// objects. The extractors below normalize that into plain arrays/objects and
// are pure, so tests can drive them with fixture payloads.
import { accessToken } from './oauth.js';

const BASE = 'https://fantasysports.yahooapis.com/fantasy/v2';

async function get(path) {
  const token = await accessToken();
  const res = await fetch(`${BASE}${path}${path.includes('?') ? '&' : '?'}format=json`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Yahoo API ${path}: HTTP ${res.status} — ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// ---- generic fantasy_content helpers (exported for tests) ----

// {count: 2, "0": {...}, "1": {...}} -> [ {...}, {...} ]
export function numbered(obj) {
  if (!obj || typeof obj !== 'object') return [];
  return Object.keys(obj)
    .filter(k => /^\d+$/.test(k))
    .sort((a, b) => Number(a) - Number(b))
    .map(k => obj[k]);
}

// [{a:1},{b:2},[],{c:3}] -> {a:1,b:2,c:3}   (Yahoo entity attribute arrays)
export function flattenAttrs(arr) {
  const out = {};
  for (const item of Array.isArray(arr) ? arr : [arr]) {
    if (item && typeof item === 'object' && !Array.isArray(item)) Object.assign(out, item);
  }
  return out;
}

// ---- payload extractors (pure) ----

export function extractLeagues(payload) {
  const out = [];
  for (const u of numbered(payload?.fantasy_content?.users)) {
    for (const g of numbered(u?.user?.[1]?.games)) {
      for (const l of numbered(g?.game?.[1]?.leagues)) {
        const meta = Array.isArray(l?.league) ? l.league[0] : l?.league;
        if (meta?.league_key) {
          out.push({
            league_key: meta.league_key, name: meta.name,
            num_teams: Number(meta.num_teams ?? 0),
            draft_status: meta.draft_status ?? null,
            season: meta.season ?? null,
          });
        }
      }
    }
  }
  return out;
}

export function extractMyTeamKey(payload) {
  for (const u of numbered(payload?.fantasy_content?.users)) {
    for (const g of numbered(u?.user?.[1]?.games)) {
      for (const t of numbered(g?.game?.[1]?.teams)) {
        const attrs = flattenAttrs(t?.team?.[0]);
        if (attrs.team_key && Number(attrs.is_owned_by_current_login ?? 0) === 1) return attrs.team_key;
      }
    }
  }
  return null;
}

export function extractDraftResults(payload) {
  const league = payload?.fantasy_content?.league;
  const dr = league?.[1]?.draft_results;
  return numbered(dr)
    .map(x => x?.draft_result)
    .filter(Boolean)
    .map(d => ({ pick: Number(d.pick), round: Number(d.round), team_key: d.team_key, player_key: d.player_key }))
    .filter(d => d.player_key) // in-progress drafts can expose empty upcoming slots
    .sort((a, b) => a.pick - b.pick);
}

export function extractPlayers(payload) {
  const league = payload?.fantasy_content?.league;
  const players = league?.[1]?.players;
  return numbered(players).map(x => {
    const attrs = flattenAttrs(x?.player?.[0]);
    return {
      player_key: attrs.player_key,
      name: attrs.name?.full ?? null,
      position: attrs.display_position ?? null,
      team: attrs.editorial_team_abbr ?? null,
    };
  }).filter(p => p.player_key);
}

export function extractLeagueSettings(payload) {
  const league = payload?.fantasy_content?.league;
  const meta = league?.[0] ?? {};
  const settings = league?.[1]?.settings?.[0] ?? {};
  return {
    name: meta.name ?? null,
    num_teams: Number(meta.num_teams ?? 0),
    scoring_type: meta.scoring_type ?? null,
    draft_status: meta.draft_status ?? null,
    roster_positions: numbered(settings.roster_positions).map(r => r?.roster_position).filter(Boolean)
      .map(r => ({ position: r.position, count: Number(r.count ?? 0) })),
  };
}

// ---- API calls ----

export const yahooApi = {
  myLeagues: async () => extractLeagues(await get('/users;use_login=1/games;game_keys=nfl/leagues')),
  myTeamKey: async () => extractMyTeamKey(await get('/users;use_login=1/games;game_keys=nfl/teams')),
  draftResults: async leagueKey => extractDraftResults(await get(`/league/${leagueKey}/draftresults`)),
  leagueSettings: async leagueKey => extractLeagueSettings(await get(`/league/${leagueKey}/settings`)),
  playersByKeys: async (leagueKey, keys) => {
    const out = [];
    for (let i = 0; i < keys.length; i += 25) {
      const batch = keys.slice(i, i + 25);
      out.push(...extractPlayers(await get(`/league/${leagueKey}/players;player_keys=${batch.join(',')}`)));
    }
    return out;
  },
};
