import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  formatDocument,
  formatQuery,
  MAX_DOCUMENT_CHARS,
  MAX_QUERY_CHARS,
} from '../server/providers/embedding/format.js';
import { getEmbeddingProvider } from '../server/providers/embedding/index.js';
import { voyageSeries } from '../server/providers/embedding/voyage.js';

const fixture = JSON.parse(
  readFileSync(new URL('../../catalog/providers/format_fixture.json', import.meta.url), 'utf8'),
);

test('format limits match the shared fixture', () => {
  assert.equal(MAX_DOCUMENT_CHARS, fixture.maxDocumentChars);
  assert.equal(MAX_QUERY_CHARS, fixture.maxQueryChars);
});

for (const { input, expected } of fixture.cases) {
  test(`formats ${JSON.stringify(input).slice(0, 40)}`, () => {
    assert.equal(formatDocument(input), expected);
    assert.equal(formatQuery(input), expected);
  });
}

test('limits count code points, so emoji are never split', () => {
  const doc = formatDocument('🧠'.repeat(MAX_DOCUMENT_CHARS + 10));
  assert.equal(Array.from(doc).length, MAX_DOCUMENT_CHARS);
  assert.equal(Array.from(formatQuery('a'.repeat(5000))).length, MAX_QUERY_CHARS);
});

test('the profile names the series, so lite queries match large documents', () => {
  assert.equal(voyageSeries('voyage-4-large'), '4-series');
  assert.equal(voyageSeries('voyage-4-lite'), '4-series');
  const large = getEmbeddingProvider({ CLASSY_EMBED_DOC_MODEL: 'voyage-4-large' });
  const lite = getEmbeddingProvider({}, { queryModel: 'voyage-4-large' });
  assert.equal(large.profile, 'voyage|4-series|1024|document');
  assert.equal(lite.profile, large.profile);
});

test('the Python packer computes the same profile string', () => {
  assert.equal(fixture.profiles?.voyage, getEmbeddingProvider({}).profile);
  assert.equal(fixture.profiles?.gemini, getEmbeddingProvider({ CLASSY_EMBED_PROVIDER: 'gemini' }).profile);
});
