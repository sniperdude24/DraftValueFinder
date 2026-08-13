// Draft Value Finder server — zero-dependency node:http.
// Serves the static frontend from public/ and a JSON API over the player DB.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessAll } from '../src/analyze/score.js';
import { marketComparison } from '../src/analyze/market.js';
import { recommendations } from '../src/analyze/recommend.js';
import { loadState, saveState, markDrafted, undoDraft, setPersonalRank } from '../src/store/state.js';
import { logRecommendations, logEvent, readHistory } from '../src/store/history.js';
import { chat } from '../src/ai/chat.js';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT ?? 3210);

// ---- load database & precompute assessments (rebuild-cheap, restart to refresh) ----
const dbPath = join(ROOT, 'data', 'players.json');
if (!existsSync(dbPath)) {
  console.error('data/players.json missing — run `npm run refresh` first.');
  process.exit(1);
}
const db = JSON.parse(readFileSync(dbPath, 'utf8'));
const assessments = assessAll(db.players);
const byId = new Map(db.players.map(p => [p.id, p]));
console.log(`Loaded ${db.players.length} players (built ${db.built_at})`);

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

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;

    if (path.startsWith('/api/')) {
      const state = loadState();

      if (req.method === 'GET' && path === '/api/meta') {
        return send(res, 200, { built_at: db.built_at, season: db.season, sources: db.sources, counts: db.counts, unmatched: db.unmatched });
      }
      if (req.method === 'GET' && path === '/api/board') {
        return send(res, 200, { players: db.players.map(p => boardRow(p, state)) });
      }
      if (req.method === 'GET' && path.startsWith('/api/player/')) {
        const id = decodeURIComponent(path.slice('/api/player/'.length));
        const p = byId.get(id);
        if (!p) return send(res, 404, { error: 'unknown player id' });
        const a = assessments.get(id);
        return send(res, 200, {
          player: p,
          assessment: {
            ai_rank: a.ai_rank, verdict: a.verdict, confidence: a.confidence,
            factors: a.factors, trend: a.trend, signal: a.signal,
          },
          personal_rank: state.personalRanks[id] ?? null,
          drafted: state.drafted.includes(id),
          mine: state.mine.includes(id),
        });
      }
      if (req.method === 'GET' && path === '/api/market') {
        return send(res, 200, marketComparison(db.players, assessments));
      }
      if (req.method === 'GET' && path === '/api/recommendations') {
        const result = recommendations(db.players, assessments, state);
        const logged = logRecommendations(result, { trigger: 'board' });
        return send(res, 200, { ...result, newly_logged: logged });
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
        return send(res, 200, { sleepers: rows });
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
        saveState({ ...state, drafted: [], mine: [] });
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
