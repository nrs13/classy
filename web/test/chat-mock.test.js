import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatFault, mockChatAllowed, streamMock } from '../server/chat/mock.js';
import { resolveChatConfig } from '../server/chat/provider.js';

test('the mock provider refuses production and Vercel', () => {
  assert.equal(mockChatAllowed({ NODE_ENV: 'production' }), false);
  assert.equal(mockChatAllowed({ VERCEL_ENV: 'preview' }), false);
  assert.equal(mockChatAllowed({ NODE_ENV: 'development' }), true);
  assert.equal(resolveChatConfig({ CHAT_PROVIDER: 'mock', NODE_ENV: 'production' }).provider, 'gemini');
  assert.equal(resolveChatConfig({ CHAT_PROVIDER: 'mock', NODE_ENV: 'test' }).provider, 'mock');
});

test('a query or header selects the mock fault', async () => {
  assert.equal(chatFault({ headers: { 'x-classy-chat-fault': 'auth' }, url: '/api/chat' }), 'auth');
  assert.equal(chatFault({ headers: {}, url: '/api/chat?chatFault=cut_stream' }), 'cut_stream');
  assert.equal(chatFault({ headers: {}, url: '/api/chat?chatFault=nope' }), '');
  const events = [];
  for await (const event of streamMock({ fault: 'cut_stream' })) events.push(event);
  assert.equal(events.at(-1).type, 'cut');
  await assert.rejects(
    (async () => {
      for await (const event of streamMock({ fault: 'minute_quota' })) events.push(event);
    })(),
    (err) => err.scope === 'minute_quota' && err.retryAfterSeconds === 60,
  );
});
