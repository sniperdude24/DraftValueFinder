// Draft Value Finder server — zero-dependency node:http.
// Serves the static frontend from public/ and a JSON API over the player DB.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessAll } from '../src/analyze/score.js';
import { marketComparison } from '../src/analyze/market.js';
import { recommendations } from '../src/analyze/recommend.js';
import { loadState, saveState, markDrafted, undoDraft, setPersonalRank, setOwner, setTeams, clearRosters, myTeamId, UNKNOWN_OWNER } from '../src/store/state.js';
import { leagueView, resolveNames } from '../src/analyze/league.js';
import { logRecommendations, logEvent, readHistory } from '../src/store/history.js';
import { chat } from '../src/ai/chat.js';
import { isConfigured, isConnected, authorizeUrl, awaitCallback } from '../src/yahoo/oauth.js';
import { yahooApi } from '../src/yahoo/client.js';
import { syncOnce, draftComplete } from '../src/yahoo/sync.js';
import { LEAGUE, rosterSummary } from '../src/analyze/roster.js';
import { runIngest } from '../src/ingest/fetchAll.js';
import { buildDatabase } from '../src/normalize/build.js';
import { isStale } from '../src/ingest/freshness.js';
import { computeWindows } from '../src/analyze/playerStats.js';
import { buildTeamContext, teamSummaries } from '../src/analyze/teamContext.js';
import {
  scoreGame, scorePlayers, rulesFor, describeRules, normalizeRules, copyPosition,
  PRESETS, DEFAULT_RULES, POSITIONS, CATEGORIES, categoriesFor,
  primaryCategoriesFor, rareCategoriesFor,
} from '../src/analyze/fantasyPoints.js';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT ?? 3210);

// ---- load database & precompute assessments (hot-reloadable via /api/admin/refresh) ----
const dbPath = join(ROOT, 'data', 'players.json');
let db, assessments, byId, activeRules = DEFAULT_RULES;

// Score every game row under the active rules. Everything downstream —
// trends, the unsustainable-spike test, the AI rank, team pages, the chat —
// reads `fantasy_points`, so this one pass is what makes a scoring change
// flow through the whole app instead of being a cosmetic column.
//
// It walks the in-memory database only. Changing scoring must never trigger
// a re-ingest or a rebuild: the components are already on disk, and the
// arithmetic over ~3k rows is instant.
function applyScoring(rules) {
  // scorePlayers applies each position's own rules and re-scores the
  // prior-season baseline from its stored component averages.
  activeRules = scorePlayers(db.players, rules);
  assessments = assessAll(db.players);
}

function currentRules(state) {
  return rulesFor(state?.scoring);
}

function loadDb() {
  db = JSON.parse(readFileSync(dbPath, 'utf8'));
  byId = new Map(db.players.map(p => [p.id, p]));
  applyScoring(currentRules(loadState()));
  console.log(`Loaded ${db.players.length} players (${db.mode ?? 'draft'} mode, stats ${db.stats_season ?? '?'}, scoring ${describeRules(activeRules)}, built ${db.built_at})`);
}

// The player database is a build artifact, not source — on a fresh clone
// there is nothing to load, so build it rather than refusing to start.
if (!existsSync(dbPath)) {
  console.log('data/players.json missing — building it from scratch (first run)…');
  await runIngest();
  buildDatabase();
}
loadDb();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

function send(res, status, body, type = 'application/json') {
  const buf = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(buf);
}

function boardRow(p, state) {
  const a = assessments.get(p.id);
  return {
    id: p.id, name: p.name, position: p.position, team: p.team, bye: p.bye,
    tier_group: p.tier_group,
    adp: p.adp?.overall ?? null, adp_rank: p.adp?.rank ?? null, adp_formatted: p.adp?.formatted ?? null,
    expert_rank: p.expert?.rank ?? null, expert_tier: p.expert?.tier ?? null, pos_rank: p.expert?.pos_rank ?? null,
    ai_rank: a.ai_rank, ai_verdict: a.verdict, confidence: a.confidence,
    usage_trend: a.trend.available ? a.trend.usage : null,
    sleeper_state: a.signal.state,
    injury_status: p.meta?.injury_status ?? null,
    personal_rank: state.personalRanks[p.id] ?? null,
    drafted: state.drafted.includes(p.id),
    mine: state.mine.includes(p.id),
    owner_id: state.owners?.[p.id] ?? null,
    pick_number: state.drafted.includes(p.id) ? state.drafted.indexOf(p.id) + 1 : null,
    changed_team: p.changed_team,
  };
}

async function readBody(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1e6) throw new Error('body too large');
  }
  return data ? JSON.parse(data) : {};
}

const autosync = { timer: null };
const refreshing = { busy: false };

// ---- auto-refresh: keep every source fresh without manual clicks ----
const autoRefresh = {
  enabled: !process.env.DVF_NO_AUTO_REFRESH,
  last_attempt: null,
  last_result: null,
};

async function doRefresh(trigger, { force = false } = {}) {
  const lines = [];
  const log = { log: m => { lines.push(m); console.log(m); }, error: m => { lines.push(m); console.error(m); } };
  const { failures, total, unchanged, downloaded } = await runIngest({ log, force });
  // Always rebuild even when every source was unchanged: the snapshots on
  // disk are re-parsed here, so a parser change still takes effect.
  buildDatabase();
  loadDb();
  return { ok: true, trigger, failures, total, unchanged, downloaded, mode: db.mode, stats_season: db.stats_season, week: db.week, built_at: db.built_at, log: lines };
}

async function maybeAutoRefresh() {
  if (!autoRefresh.enabled || refreshing.busy || !isStale(db.built_at)) return;
  refreshing.busy = true;
  autoRefresh.last_attempt = new Date().toISOString();
  try {
    const r = await doRefresh('auto');
    autoRefresh.last_result = `ok — ${r.total - r.failures}/${r.total} sources, ${r.mode} mode`;
    console.log(`Auto-refresh complete (${autoRefresh.last_result})`);
  } catch (err) {
    autoRefresh.last_result = `failed: ${err.message}`;
    console.error('Auto-refresh failed:', err.message);
  } finally {
    refreshing.busy = false;
  }
}
setTimeout(maybeAutoRefresh, 3000);
setInterval(maybeAutoRefresh, 60 * 60 * 1000);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;

    if (path.startsWith('/api/')) {
      const state = loadState();

      if (req.method === 'GET' && path === '/api/meta') {
        return send(res, 200, { built_at: db.built_at, mode: db.mode, season: db.season, stats_season: db.stats_season, baseline_season: db.baseline_season, week: db.week, sources: db.sources, counts: db.counts, unmatched: db.unmatched, auto_refresh: autoRefresh, scoring: describeRules(activeRules) });
      }
      if (req.method === 'GET' && path === '/api/board') {
        return send(res, 200, { mode: db.mode, week: db.week, stats_season: db.stats_season, teams: state.league.teams, players: db.players.map(p => boardRow(p, state)) });
      }
      if (req.method === 'POST' && path === '/api/admin/refresh') {
        if (refreshing.busy) return send(res, 409, { error: 'A refresh is already running' });
        refreshing.busy = true;
        try {
          // ?force=1 ignores cached validators — the escape hatch for when a
          // source republishes without changing its ETag.
          return send(res, 200, await doRefresh('manual', { force: url.searchParams.get('force') === '1' }));
        } finally {
          refreshing.busy = false;
        }
      }
      if (req.method === 'GET' && path.startsWith('/api/player/')) {
        const id = decodeURIComponent(path.slice('/api/player/'.length));
        const p = byId.get(id);
        if (!p) return send(res, 404, { error: 'unknown player id' });
        const a = assessments.get(id);
        return send(res, 200, {
          player: p,
          windows: computeWindows(p),
          assessment: {
            ai_rank: a.ai_rank, verdict: a.verdict, confidence: a.confidence,
            factors: a.factors, trend: a.trend, signal: a.signal,
          },
          personal_rank: state.personalRanks[id] ?? null,
          drafted: state.drafted.includes(id),
          mine: state.mine.includes(id),
        });
      }
      if (req.method === 'GET' && path === '/api/league') {
        return send(res, 200, { mode: db.mode, week: db.week, ...leagueView(db.players, state) });
      }
      if (req.method === 'PUT' && path === '/api/league/teams') {
        const { teams } = await readBody(req);
        if (!Array.isArray(teams) || !teams.length) return send(res, 400, { error: 'teams array required' });
        saveState(setTeams(state, teams));
        return send(res, 200, { ok: true, ...leagueView(db.players, loadState()) });
      }
      if (req.method === 'POST' && path === '/api/league/owner') {
        const { id, team_id = null } = await readBody(req);
        if (!byId.has(id)) return send(res, 404, { error: 'unknown player id' });
        try {
          saveState(setOwner(state, id, team_id));
        } catch (err) {
          return send(res, 400, { error: err.message });
        }
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && path === '/api/league/bulk') {
        const { team_id, text, commit = false } = await readBody(req);
        if (team_id !== UNKNOWN_OWNER && !state.league.teams.some(t => t.id === team_id)) {
          return send(res, 400, { error: `unknown team "${team_id}"` });
        }
        const resolved = resolveNames(text, db.players);
        // Two-step by design: resolve and report first, write only when the
        // caller confirms. Nothing pasted is applied while names are still
        // unmatched or ambiguous without the user having seen them.
        if (commit) {
          for (const m of resolved.matched) setOwner(state, m.id, team_id);
          saveState(state);
        }
        return send(res, 200, { ok: true, committed: !!commit, ...resolved });
      }
      if (req.method === 'POST' && path === '/api/league/reset') {
        const { team_id = null } = await readBody(req);
        saveState(clearRosters(state, { teamId: team_id }));
        logEvent({ trigger: team_id ? 'roster_clear' : 'draft_reset', team_id });
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && path === '/api/scoring') {
        return send(res, 200, {
          preset: describeRules(activeRules),
          rules: activeRules,
          presets: PRESETS,
          positions: POSITIONS,
          // Labels and which positions each category applies to, so the
          // settings screen is built from the engine's own definitions
          // rather than a second list that could drift out of step.
          categories: Object.fromEntries(
            Object.entries(CATEGORIES).map(([k, [label, short]]) => [k, { label, short }])),
          primary: Object.fromEntries(POSITIONS.map(p => [p, primaryCategoriesFor(p)])),
          rare: Object.fromEntries(POSITIONS.map(p => [p, rareCategoriesFor(p)])),
          // The market columns come from PPR-specific endpoints and cannot
          // follow custom scoring; the UI must say so rather than imply the
          // comparison is like-for-like.
          market_is_ppr: true,
        });
      }
      if (req.method === 'PUT' && path === '/api/scoring') {
        const body = await readBody(req);
        const preset = body?.preset ?? 'custom';
        if (preset !== 'custom' && !PRESETS[preset]) {
          return send(res, 400, { error: `unknown preset "${preset}"` });
        }
        let scoring;
        if (preset === 'custom') {
          // Validate every value rather than letting a stray blank become NaN
          // and quietly poison every score downstream. A zero per-unit would
          // divide by zero, so it is rejected rather than silently coerced.
          const rules = {};
          for (const pos of POSITIONS) {
            rules[pos] = {};
            for (const key of categoriesFor(pos)) {
              const raw = body?.rules?.[pos]?.[key];
              if (raw == null) continue;
              const [pts, per] = Array.isArray(raw) ? raw : [raw, 1];
              const p = Number(pts), u = Number(per);
              if (!Number.isFinite(p)) return send(res, 400, { error: `${pos} ${key}: points must be a number` });
              if (!Number.isFinite(u) || u === 0) return send(res, 400, { error: `${pos} ${key}: per-unit must be a non-zero number` });
              rules[pos][key] = [p, u];
            }
          }
          scoring = { preset: 'custom', rules };
        } else {
          scoring = { preset, rules: null };
        }
        saveState({ ...state, scoring });
        applyScoring(rulesFor(scoring));
        return send(res, 200, { ok: true, preset: describeRules(activeRules), rules: activeRules });
      }
      if (req.method === 'POST' && path === '/api/scoring/copy') {
        // The "same scoring as RB?" convenience — copy one position's rules
        // onto another rather than retyping fourteen numbers.
        const { from, to } = await readBody(req);
        if (!POSITIONS.includes(from) || !POSITIONS.includes(to)) {
          return send(res, 400, { error: 'from/to must both be QB, RB, WR or TE' });
        }
        const rules = copyPosition(activeRules, from, to);
        saveState({ ...state, scoring: { preset: 'custom', rules } });
        applyScoring(rules);
        return send(res, 200, { ok: true, preset: describeRules(activeRules), rules: activeRules });
      }
      if (req.method === 'GET' && path === '/api/teams') {
        return send(res, 200, { mode: db.mode, stats_season: db.stats_season, teams: teamSummaries(db.players) });
      }
      if (req.method === 'GET' && path.startsWith('/api/teams/')) {
        const code = decodeURIComponent(path.slice('/api/teams/'.length)).toUpperCase();
        const ctx = buildTeamContext(db.players, code, { teamRedzone: db.team_redzone?.[code] ?? null });
        // Attach each player's assessment so the UI can show trend/AI/signal
        // alongside the distribution without a second round trip.
        const enrich = row => {
          const a = assessments.get(row.id);
          return a ? { ...row, ai_rank: a.ai_rank, usage_trend: a.trend.available ? a.trend.usage : null, sleeper_state: a.signal.state } : row;
        };
        ctx.season.rows = ctx.season.rows.map(enrich);
        ctx.recent.rows = ctx.recent.rows.map(enrich);
        if (ctx.redzone) ctx.redzone.rows = ctx.redzone.rows.map(enrich);
        return send(res, 200, { mode: db.mode, stats_season: db.stats_season, week: db.week, ...ctx });
      }
      if (req.method === 'GET' && path === '/api/players') {
        return send(res, 200, {
          mode: db.mode, week: db.week, stats_season: db.stats_season,
          scoring: describeRules(activeRules),
          teams: state.league.teams,
          players: db.players.map(p => {
            const a = assessments.get(p.id);
            return {
              id: p.id, name: p.name, position: p.position, team: p.team, bye: p.bye,
              ai_rank: a.ai_rank, confidence: a.confidence,
              usage_trend: a.trend.available ? a.trend.usage : null,
              sleeper_state: a.signal.state,
              injury_status: p.meta?.injury_status ?? null,
              changed_team: p.changed_team,
              expert_rank: p.expert?.rank ?? null,
              rostered: state.drafted.includes(p.id),
              mine: state.mine.includes(p.id),
              owner_id: state.owners?.[p.id] ?? null,
              windows: computeWindows(p),
            };
          }),
        });
      }
      if (req.method === 'GET' && path === '/api/team') {
        const minePlayers = db.players
          .filter(p => state.mine.includes(p.id))
          .sort((a, b) => state.drafted.indexOf(a.id) - state.drafted.indexOf(b.id))
          .map(p => {
            const a = assessments.get(p.id);
            return {
              ...p,
              pick_number: state.drafted.indexOf(p.id) + 1 || null,
              ai_rank: a.ai_rank, confidence: a.confidence, verdict: a.verdict,
              usage_trend: a.trend.available ? a.trend.usage : null,
              sleeper_state: a.signal.state,
              personal_rank: state.personalRanks[p.id] ?? null,
            };
          });
        return send(res, 200, {
          mode: db.mode, week: db.week, stats_season: db.stats_season,
          projection_meta: db.sources.projections,
          roster: rosterSummary(minePlayers),
          players: minePlayers,
        });
      }
      if (req.method === 'GET' && path === '/api/market') {
        return send(res, 200, marketComparison(db.players, assessments));
      }
      if (req.method === 'GET' && path === '/api/recommendations') {
        const result = recommendations(db.players, assessments, state, { mode: db.mode ?? 'draft' });
        const logged = logRecommendations(result, { trigger: db.mode === 'season' ? 'waiver' : 'board' });
        return send(res, 200, { ...result, week: db.week, newly_logged: logged });
      }
      if (req.method === 'GET' && path === '/api/sleepers') {
        const rows = db.players
          .map(p => ({ p, a: assessments.get(p.id) }))
          .filter(({ a }) => ['signal', 'emerging'].includes(a.signal.state))
          .map(({ p, a }) => ({
            id: p.id, name: p.name, position: p.position, team: p.team, bye: p.bye,
            adp_rank: p.adp?.rank ?? null, expert_rank: p.expert?.rank ?? null,
            ai_rank: a.ai_rank, confidence: a.confidence,
            state: a.signal.state, reason: a.signal.reason,
            evidence: a.signal.evidence, context: a.signal.context,
            drafted: state.drafted.includes(p.id),
            late_round: (p.adp?.rank ?? p.expert?.rank ?? 999) > 60,
          }));
        return send(res, 200, { mode: db.mode, week: db.week, sleepers: rows });
      }
      if (req.method === 'GET' && path === '/api/history') {
        return send(res, 200, { events: readHistory().slice(-500).reverse() });
      }
      if (req.method === 'POST' && path === '/api/draft') {
        const { id, mine = false } = await readBody(req);
        if (!byId.has(id)) return send(res, 404, { error: 'unknown player id' });
        saveState(markDrafted(state, id, { mine }));
        logEvent({ trigger: 'draft_pick', player_id: id, player: byId.get(id).name, mine, pick: state.drafted.length });
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && path === '/api/undraft') {
        const { id } = await readBody(req);
        saveState(undoDraft(state, id));
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && path === '/api/reset-draft') {
        saveState(clearRosters(state));
        logEvent({ trigger: 'draft_reset' });
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && path === '/api/personal-rank') {
        const { id, rank } = await readBody(req);
        if (!byId.has(id)) return send(res, 404, { error: 'unknown player id' });
        const r = rank == null || rank === '' ? null : Number(rank);
        if (r != null && (!Number.isInteger(r) || r < 1 || r > 500)) return send(res, 400, { error: 'rank must be an integer 1-500' });
        saveState(setPersonalRank(state, id, r));
        return send(res, 200, { ok: true });
      }
      // ---- Yahoo draft sync (optional; absent credentials disable it) ----
      if (req.method === 'GET' && path === '/api/yahoo/status') {
        return send(res, 200, {
          configured: isConfigured(),
          connected: isConfigured() && isConnected(),
          league: state.yahoo ?? null,
          autosync: autosync.timer != null,
        });
      }
      if (req.method === 'POST' && path === '/api/yahoo/connect') {
        if (!isConfigured()) return send(res, 400, { error: 'Set YAHOO_CLIENT_ID and YAHOO_CLIENT_SECRET in .env first' });
        awaitCallback().then(() => console.log('Yahoo connected'), err => console.error('Yahoo connect:', err.message));
        return send(res, 200, { authorize_url: authorizeUrl() });
      }
      if (req.method === 'GET' && path === '/api/yahoo/leagues') {
        return send(res, 200, { leagues: await yahooApi.myLeagues() });
      }
      if (req.method === 'POST' && path === '/api/yahoo/league') {
        const { league_key } = await readBody(req);
        if (!league_key) return send(res, 400, { error: 'league_key required' });
        const [team_key, settings] = await Promise.all([yahooApi.myTeamKey(), yahooApi.leagueSettings(league_key)]);
        const warnings = [];
        if (settings.num_teams && settings.num_teams !== LEAGUE.teams) {
          warnings.push(`League has ${settings.num_teams} teams; the analyzer is built for ${LEAGUE.teams}. Rankings still work, but pick-value and scarcity math assume ${LEAGUE.teams} teams.`);
        }
        if (settings.scoring_type && settings.scoring_type !== 'headpoint' && !/ppr/i.test(settings.scoring_type)) {
          warnings.push(`League scoring_type is "${settings.scoring_type}"; the analyzer assumes PPR.`);
        }
        saveState({ ...state, yahoo: { league_key, team_key, league_name: settings.name, num_teams: settings.num_teams, warnings } });
        return send(res, 200, { ok: true, team_key, settings, warnings });
      }
      if (req.method === 'POST' && path === '/api/yahoo/sync') {
        return send(res, 200, await syncOnce(db));
      }
      if (req.method === 'POST' && path === '/api/yahoo/autosync') {
        const { on } = await readBody(req);
        clearInterval(autosync.timer);
        autosync.timer = null;
        if (on) {
          autosync.timer = setInterval(async () => {
            try {
              const r = await syncOnce(db);
              if (draftComplete(r.picks)) {
                clearInterval(autosync.timer);
                autosync.timer = null;
                console.log('Yahoo autosync: draft complete, stopped');
              }
            } catch (err) {
              console.error('Yahoo autosync:', err.message);
            }
          }, 10000);
        }
        return send(res, 200, { autosync: autosync.timer != null });
      }

      if (req.method === 'POST' && path === '/api/chat') {
        const { message, history = [] } = await readBody(req);
        if (!message || typeof message !== 'string') return send(res, 400, { error: 'message required' });
        const reply = await chat({ message, history, db, assessments, state });
        return send(res, 200, reply);
      }
      return send(res, 404, { error: 'not found' });
    }

    // ---- static files ----
    let file = path === '/' ? '/index.html' : path;
    const full = normalize(join(PUBLIC, file));
    if (!full.startsWith(PUBLIC)) return send(res, 403, { error: 'forbidden' });
    if (!existsSync(full)) return send(res, 404, 'not found', 'text/plain');
    return send(res, 200, readFileSync(full), MIME[extname(full)] ?? 'application/octet-stream');
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => console.log(`Draft Value Finder → http://localhost:${PORT}`));
