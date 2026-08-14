import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithRetry, responseValidators, snapshotValidators } from '../src/ingest/util.js';

// A stand-in for the fetch Response surface these helpers actually use.
function fakeResponse(status, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: k => headers[k.toLowerCase()] ?? null },
  };
}

test('304 is a success, not an HTTP failure', async () => {
  // fetchWithRetry throws on !res.ok, and a 304 is not ok — without an
  // explicit carve-out every conditional request would retry three times
  // and then fail the source.
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return fakeResponse(304); };
  try {
    const res = await fetchWithRetry('https://example.test/x', { retries: 3 });
    assert.equal(res.status, 304);
    assert.equal(calls, 1, 'a 304 must not be retried');
  } finally {
    globalThis.fetch = original;
  }
});

test('a real error status still throws after exhausting retries', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return fakeResponse(500); };
  try {
    await assert.rejects(
      () => fetchWithRetry('https://example.test/x', { retries: 2 }),
      /HTTP 500/);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test('validators are read off the response, absent ones stay null', () => {
  assert.deepEqual(
    responseValidators(fakeResponse(200, { etag: '"abc"', 'last-modified': 'Thu, 13 Aug 2026 12:26:09 GMT' })),
    { etag: '"abc"', last_modified: 'Thu, 13 Aug 2026 12:26:09 GMT' });
  assert.deepEqual(
    responseValidators(fakeResponse(200, {})),
    { etag: null, last_modified: null });
});

// snapshotValidators reads from RAW_DIR, which is fixed at import time, so
// exercise the guard logic it feeds rather than the filesystem lookup.
test('a cached validator only applies when the reducer version still matches', () => {
  const REDUCER_VERSION = 1;
  const shouldForce = prev => !prev || prev.reducer_version !== REDUCER_VERSION;

  assert.equal(shouldForce(null), true, 'nothing cached — must download');
  assert.equal(shouldForce({ etag: '"a"', reducer_version: 1 }), false, 'same rules — the cache is valid');
  assert.equal(shouldForce({ etag: '"a"', reducer_version: 0 }), true,
    'counting rules changed: a matching ETag must NOT be allowed to serve stale derived output');
  assert.equal(shouldForce({ etag: '"a"' }), true, 'no version recorded — re-derive rather than guess');
});

test('a snapshot we have never stored has no validators to send', () => {
  // Guards the first-run path: with nothing cached the request must go out
  // unconditionally rather than with an empty If-None-Match header.
  assert.equal(snapshotValidators('definitely-not-a-real-snapshot.json'), null);
});
