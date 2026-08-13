// Recommendation history: an append-only JSONL accountability log.
// Every meaningful recommendation is recorded with the full context that
// produced it, so the system's calls can later be compared against reality.
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../ingest/util.js';

const HISTORY_PATH = join(ROOT, 'data', 'history.jsonl');

export function logRecommendations(recResult, { trigger }) {
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  const existing = readHistory();
  const seen = new Set(existing.map(e => `${e.player_id}|${e.current_pick}`));
  const lines = [];
  for (const r of recResult.recommendations) {
    const key = `${r.id}|${recResult.current_pick}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(JSON.stringify({
      at: new Date().toISOString(),
      trigger,
      current_pick: recResult.current_pick,
      round: recResult.round,
      player_id: r.id,
      player: r.name,
      position: r.position,
      team: r.team,
      adp_rank: r.adp_rank,
      expert_rank: r.expert_rank,
      ai_rank: r.ai_rank,
      confidence: r.confidence,
      sleeper_state: r.sleeper_state,
      value_vs_pick: r.value_vs_pick,
      why: r.why,
      risk: r.risk,
    }));
  }
  if (lines.length) appendFileSync(HISTORY_PATH, lines.join('\n') + '\n');
  return lines.length;
}

export function logEvent(event) {
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  appendFileSync(HISTORY_PATH, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
}

export function readHistory() {
  if (!existsSync(HISTORY_PATH)) return [];
  return readFileSync(HISTORY_PATH, 'utf8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}
