import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStale, STALE_AFTER_MS } from '../src/ingest/freshness.js';

const T0 = Date.parse('2026-08-13T12:00:00Z');

test('data newer than the threshold is fresh', () => {
  assert.equal(isStale(new Date(T0 - STALE_AFTER_MS + 60000).toISOString(), T0), false);
});

test('data older than the threshold is stale', () => {
  assert.equal(isStale(new Date(T0 - STALE_AFTER_MS - 60000).toISOString(), T0), true);
});

test('missing or unparsable built_at counts as stale', () => {
  assert.equal(isStale(null, T0), true);
  assert.equal(isStale('not-a-date', T0), true);
});
