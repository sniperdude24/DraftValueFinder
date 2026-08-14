async function req(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export const api = {
  meta: () => req('/api/meta'),
  board: () => req('/api/board'),
  team: () => req('/api/team'),
  players: () => req('/api/players'),
  teams: () => req('/api/teams'),
  teamContext: code => req(`/api/teams/${encodeURIComponent(code)}`),
  player: id => req(`/api/player/${encodeURIComponent(id)}`),
  market: () => req('/api/market'),
  recommendations: () => req('/api/recommendations'),
  sleepers: () => req('/api/sleepers'),
  history: () => req('/api/history'),
  league: () => req('/api/league'),
  setTeams: teams => req('/api/league/teams', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ teams }) }),
  setOwner: (id, team_id) => req('/api/league/owner', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, team_id }) }),
  bulkRoster: (team_id, text, commit) => req('/api/league/bulk', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ team_id, text, commit }) }),
  resetRoster: team_id => req('/api/league/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ team_id }) }),
  scoring: () => req('/api/scoring'),
  copyScoring: (from, to) => req('/api/scoring/copy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from, to }) }),
  setScoring: body => req('/api/scoring', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  draft: (id, mine) => req('/api/draft', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, mine }) }),
  undraft: id => req('/api/undraft', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) }),
  resetDraft: () => req('/api/reset-draft', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  personalRank: (id, rank) => req('/api/personal-rank', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, rank }) }),
  chat: (message, history) => req('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, history }) }),
  adminRefresh: ({ force = false } = {}) => req(`/api/admin/refresh${force ? '?force=1' : ''}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  yahoo: {
    status: () => req('/api/yahoo/status'),
    connect: () => req('/api/yahoo/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
    leagues: () => req('/api/yahoo/leagues'),
    setLeague: league_key => req('/api/yahoo/league', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ league_key }) }),
    sync: () => req('/api/yahoo/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
    autosync: on => req('/api/yahoo/autosync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on }) }),
  },
};

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function trendArrow(t) {
  if (t === 'rising') return '<span class="trend-up" title="snaps AND opportunities rising">▲▲</span>';
  if (t === 'mixed-up') return '<span class="trend-up" title="one of snaps/opportunities rising">▲</span>';
  if (t === 'falling') return '<span class="trend-down" title="snaps AND opportunities falling">▼▼</span>';
  if (t === 'mixed-down') return '<span class="trend-down" title="one of snaps/opportunities falling">▼</span>';
  if (t === 'flat') return '<span class="trend-flat">—</span>';
  return '<span class="trend-flat" title="no 2025 usage data">·</span>';
}

export function signalBadge(s) {
  if (s === 'signal') return '<span class="badge signal">SLEEPER SIGNAL</span>';
  if (s === 'emerging') return '<span class="badge emerging">EMERGING</span>';
  return '';
}

export function pct(v) { return v == null ? '—' : `${Math.round(v * 100)}%`; }
