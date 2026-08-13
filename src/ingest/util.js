// Shared ingestion utilities: resilient fetch, snapshot persistence, CSV parsing.
// Every snapshot is saved with a sidecar .meta.json recording source + fetched_at,
// so downstream layers always know where a number came from and how old it is.
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RAW_DIR = join(ROOT, 'data', 'raw');

const UA = 'DraftValueFinder/0.1 (personal draft tool)';

export async function fetchWithRetry(url, { retries = 3, timeoutMs = 60000, headers = {} } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, ...headers },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr;
}

export async function fetchText(url, opts) {
  return (await fetchWithRetry(url, opts)).text();
}

export async function fetchJson(url, opts) {
  return (await fetchWithRetry(url, opts)).json();
}

export function saveSnapshot(name, content, meta) {
  mkdirSync(RAW_DIR, { recursive: true });
  const path = join(RAW_DIR, name);
  const body = typeof content === 'string' ? content : JSON.stringify(content);
  writeFileSync(path, body);
  writeFileSync(path + '.meta.json', JSON.stringify({
    fetched_at: new Date().toISOString(),
    bytes: Buffer.byteLength(body),
    ...meta,
  }, null, 2));
  return path;
}

export function loadSnapshot(name) {
  const path = join(RAW_DIR, name);
  if (!existsSync(path)) return null;
  const metaPath = path + '.meta.json';
  return {
    body: readFileSync(path, 'utf8'),
    meta: existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : null,
  };
}

// Minimal RFC-4180-ish CSV parser (quoted fields, embedded commas/newlines).
// Returns array of objects keyed by header row.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1)
    .filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''))
    .map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}
