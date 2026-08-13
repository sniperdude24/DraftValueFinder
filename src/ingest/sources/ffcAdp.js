// ADP source: Fantasy Football Calculator public API.
// Real mock-draft ADP, updated continuously. Includes bye weeks.
import { fetchJson, saveSnapshot } from '../util.js';

const URL = 'https://fantasyfootballcalculator.com/api/v1/adp/ppr?teams=10&year=2026';

export async function ingestFfcAdp() {
  const json = await fetchJson(URL);
  if (json.status !== 'Success' || !Array.isArray(json.players)) {
    throw new Error('FFC ADP: unexpected response shape');
  }
  saveSnapshot('ffc_adp.json', json, {
    source: 'Fantasy Football Calculator',
    url: URL,
    kind: 'adp',
    detail: `PPR, 10-team, ${json.meta?.total_drafts ?? '?'} drafts ${json.meta?.start_date ?? ''}..${json.meta?.end_date ?? ''}`,
  });
  return { players: json.players.length, drafts: json.meta?.total_drafts };
}
