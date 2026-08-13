import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/ingest/util.js';

test('parseCsv handles quoted fields with commas and escaped quotes', () => {
  const rows = parseCsv('a,b,c\n1,"x, y",3\n4,"he said ""hi""",6\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].b, 'x, y');
  assert.equal(rows[1].b, 'he said "hi"');
});

test('parseCsv handles CRLF and trailing newline', () => {
  const rows = parseCsv('a,b\r\n1,2\r\n3,4\r\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[1].a, '3');
});

test('parseCsv handles newlines inside quoted fields', () => {
  const rows = parseCsv('a,b\n"line1\nline2",2\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].a, 'line1\nline2');
});
