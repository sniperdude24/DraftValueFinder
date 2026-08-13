// Yahoo OAuth2 (authorization-code flow).
//
// Yahoo requires an HTTPS redirect URI, so the one-shot callback listener
// runs on a self-signed localhost cert (browser shows a warning once during
// connect — expected and harmless for a loopback address). Tokens live in
// data/yahoo-tokens.json (gitignored) and refresh silently.
import { createServer } from 'node:https';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../ingest/util.js';

const AUTH_URL = 'https://api.login.yahoo.com/oauth2/request_auth';
const TOKEN_URL = 'https://api.login.yahoo.com/oauth2/get_token';
export const CALLBACK_PORT = 8443;
export const REDIRECT_URI = `https://localhost:${CALLBACK_PORT}/yahoo/callback`;

const TOKENS_PATH = join(ROOT, 'data', 'yahoo-tokens.json');
const CERT_PATH = join(ROOT, 'data', 'yahoo-cert.json');

export function isConfigured() {
  return Boolean(process.env.YAHOO_CLIENT_ID && process.env.YAHOO_CLIENT_SECRET);
}

export function isConnected() {
  return existsSync(TOKENS_PATH);
}

export function authorizeUrl() {
  const u = new URL(AUTH_URL);
  u.searchParams.set('client_id', process.env.YAHOO_CLIENT_ID);
  u.searchParams.set('redirect_uri', REDIRECT_URI);
  u.searchParams.set('response_type', 'code');
  return u.toString();
}

async function localCert() {
  if (existsSync(CERT_PATH)) return JSON.parse(readFileSync(CERT_PATH, 'utf8'));
  const { default: selfsigned } = await import('selfsigned');
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { days: 3650, keySize: 2048 });
  const cert = { key: pems.private, cert: pems.cert };
  writeFileSync(CERT_PATH, JSON.stringify(cert));
  return cert;
}

async function exchange(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: 'Basic ' + Buffer.from(`${process.env.YAHOO_CLIENT_ID}:${process.env.YAHOO_CLIENT_SECRET}`).toString('base64'),
    },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) throw new Error(`Yahoo token endpoint: HTTP ${res.status} — ${(await res.text()).slice(0, 300)}`);
  const tok = await res.json();
  writeFileSync(TOKENS_PATH, JSON.stringify({
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: Date.now() + (tok.expires_in - 120) * 1000,
  }, null, 1));
  return tok;
}

// Start the one-shot HTTPS callback listener. Resolves once Yahoo redirects
// back with a code and the token exchange completes (or rejects on timeout).
let pendingServer = null;
export async function awaitCallback({ timeoutMs = 5 * 60 * 1000 } = {}) {
  if (pendingServer) { pendingServer.close(); pendingServer = null; }
  const cert = await localCert();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { server.close(); pendingServer = null; reject(new Error('Timed out waiting for the Yahoo callback')); }, timeoutMs);
    const server = createServer(cert, async (req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      if (!url.pathname.startsWith('/yahoo/callback')) { res.writeHead(404); return res.end(); }
      const code = url.searchParams.get('code');
      try {
        if (!code) throw new Error(url.searchParams.get('error_description') ?? 'Yahoo returned no authorization code');
        await exchange({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<body style="font-family:sans-serif;background:#0f1420;color:#e8ecf5;padding:40px"><h2>Yahoo connected ✓</h2>You can close this tab and return to the Draft Value Finder.</body>');
        resolve(true);
      } catch (err) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(`Yahoo connect failed: ${err.message}`);
        reject(err);
      } finally {
        clearTimeout(timer);
        server.close();
        pendingServer = null;
      }
    });
    server.listen(CALLBACK_PORT);
    pendingServer = server;
  });
}

export async function accessToken() {
  if (!isConnected()) throw new Error('Yahoo is not connected — use Connect on the Data page first');
  const tok = JSON.parse(readFileSync(TOKENS_PATH, 'utf8'));
  if (Date.now() < tok.expires_at) return tok.access_token;
  const fresh = await exchange({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, redirect_uri: REDIRECT_URI });
  return fresh.access_token;
}
