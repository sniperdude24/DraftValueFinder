// Expert consensus rankings: FantasyPros PPR cheat sheet page.
// The page embeds its ranking dataset as a JS literal (`var ecrData = {...};`).
// We extract that JSON verbatim — no interpretation at ingest time.
// This is a scrape of page-embedded data, so it is the most fragile source;
// failures here must never block the rest of ingestion (fetchAll handles that).
import { fetchText, saveSnapshot } from '../util.js';

const URL = 'https://www.fantasypros.com/nfl/rankings/ppr-cheatsheets.php';

export function extractEcrData(html) {
  const m = html.match(/var\s+ecrData\s*=\s*(\{)/);
  if (!m) throw new Error('FantasyPros: ecrData not found in page');
  // Walk from the opening brace to its balanced close (string-aware).
  const start = m.index + m[0].length - 1;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return JSON.parse(html.slice(start, i + 1));
    }
  }
  throw new Error('FantasyPros: unbalanced ecrData literal');
}

export async function ingestFantasyPros() {
  const html = await fetchText(URL, {
    headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  });
  const data = extractEcrData(html);
  if (!Array.isArray(data.players) || data.players.length < 50) {
    throw new Error(`FantasyPros: ecrData has ${data.players?.length ?? 0} players — refusing suspicious snapshot`);
  }
  saveSnapshot('fantasypros_ecr.json', data, {
    source: 'FantasyPros expert consensus (PPR)',
    url: URL,
    kind: 'expert_rankings',
    detail: `${data.players.length} players, ${data.total_experts ?? '?'} experts, accessed ${data.last_updated ?? 'unknown update date'}`,
  });
  return { players: data.players.length, last_updated: data.last_updated };
}
