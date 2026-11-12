import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ChatProviderError } from '../server/chat/providerError.js';
import { resolveChatConfig } from '../server/chat/provider.js';
import { streamGemini } from '../server/chat/geminiProvider.js';

test('gemini is the default chat provider and model', () => {
  const config = resolveChatConfig({});
  assert.equal(config.provider, 'gemini');
  assert.equal(config.model, 'gemini-3.5-flash-lite');
  assert.equal(config.apiKey, '');
  const anthropic = resolveChatConfig({
    CHAT_PROVIDER: 'anthropic',
    CLASSY_MODEL: 'claude-haiku-4-5',
    ANTHROPIC_API_KEY: 'anthropic-test',
  });
  assert.equal(anthropic.provider, 'anthropic');
  assert.equal(anthropic.model, 'claude-haiku-4-5');
  assert.equal(resolveChatConfig({ CHAT_PROVIDER: 'other' }).provider, 'gemini');
});

test('the gemini request keeps the key in a header and streams text', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, options });
    const body = `data: ${JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'Hello' }] } }],
    })}\n\n`;
    return {
      ok: true,
      status: 200,
      async text() {
        return '';
      },
      body: {
        getReader() {
          let sent = false;
          return {
            async read() {
              if (sent) return { done: true, value: undefined };
              sent = true;
              return { done: false, value: new TextEncoder().encode(body) };
            },
          };
        },
      },
    };
  };
  const chunks = [];
  for await (const event of streamGemini({
    apiKey: 'test-gemini-key',
    model: 'gemini-3.5-flash-lite',
    system: 'base',
    messages: [{ role: 'user', content: 'hello' }],
    maxOutputTokens: 32,
    fetchImpl,
  })) {
    chunks.push(event);
  }
  assert.equal(chunks[0].text, 'Hello');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].options.headers['x-goog-api-key'], 'test-gemini-key');
  assert.equal(seen[0].url.includes('key='), false);
  assert.equal(seen[0].url.includes('test-gemini-key'), false);
  const sent = JSON.parse(seen[0].options.body);
  assert.equal(sent.contents[0].role, 'user');
});

test('a gemini 401 is an auth failure and does not keep the response body', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    async text() {
      return 'key rejected in this body';
    },
  });
  await assert.rejects(
    async () => {
      for await (const _event of streamGemini({
        apiKey: 'test-gemini-key',
        model: 'gemini-3.5-flash-lite',
        system: 'base',
        messages: [{ role: 'user', content: 'hello' }],
        maxOutputTokens: 32,
        fetchImpl,
      })) {
      }
    },
    (err) => {
      assert.ok(err instanceof ChatProviderError);
      assert.equal(err.errorType, 'auth');
      assert.equal(err.status, 401);
      assert.equal(String(err.message).includes('key rejected'), false);
      return true;
    },
  );
});

test('gemini maps quota, auth, server, and timeout without keeping the body', async () => {
  const cases = [
    { status: 429, body: 'RESOURCE_EXHAUSTED quota id hidden', errorType: 'minute_quota' },
    { status: 401, body: 'API key not valid', errorType: 'auth' },
    { status: 503, body: 'unavailable', errorType: 'server' },
  ];
  for (const item of cases) {
    await assert.rejects(
      async () => {
        for await (const _event of streamGemini({
          apiKey: 'test-gemini-key',
          model: 'gemini-3.5-flash-lite',
          system: 'base',
          messages: [{ role: 'user', content: 'hello there' }],
          maxOutputTokens: 32,
          fetchImpl: async () => ({
            ok: false,
            status: item.status,
            async text() {
              return item.body;
            },
          }),
        })) {
        }
      },
      (err) => err instanceof ChatProviderError && err.errorType === item.errorType && !String(err.message).includes('key'),
    );
  }
  await assert.rejects(
    () =>
      streamGemini({
        apiKey: 'test-gemini-key',
        model: 'gemini-3.5-flash-lite',
        system: 'base',
        messages: [{ role: 'user', content: 'hello there' }],
        maxOutputTokens: 32,
        timeoutMs: 20,
        fetchImpl: (_url, options) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      }).next(),
    (err) => err instanceof ChatProviderError && err.errorType === 'timeout',
  );
});

test('the browser sources do not read the chat key', () => {
  const app = readFileSync(new URL('../src/lib/ai.js', import.meta.url), 'utf8');
  assert.equal(app.includes('GEMINI_CHAT_API_KEY'), false);
  assert.equal(app.includes('x-goog-api-key'), false);
});
