import { ChatProviderError } from './providerError.js';

const MOCK_FAULTS = ['minute_quota', 'day_quota', 'auth', 'server', 'timeout', 'slow_stream', 'cut_stream'];

export function mockChatAllowed(env = process.env) {
  return env.NODE_ENV !== 'production' && !env.VERCEL_ENV;
}

export function chatFault(req) {
  const header = req?.headers?.['x-classy-chat-fault'];
  let query = '';
  try {
    query = new URL(req?.url || '/', 'http://local').searchParams.get('chatFault') || '';
  } catch {
    query = '';
  }
  const name = String(header || query).trim();
  return MOCK_FAULTS.includes(name) ? name : '';
}

export function mockSlowMs(req) {
  if (!mockChatAllowed()) return undefined;
  try {
    const n = Number(new URL(req?.url || '/', 'http://local').searchParams.get('chatSlowMs'));
    if (Number.isFinite(n) && n >= 0 && n <= 30_000) return n;
  } catch {
    return undefined;
  }
  return undefined;
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export let mockStarts = 0;

export function resetMockStarts() {
  mockStarts = 0;
}

export function mockFaultError(fault) {
  if (fault === 'minute_quota') {
    return new ChatProviderError('minute_quota', 429, { scope: 'minute_quota', retryAfterSeconds: 60 });
  }
  if (fault === 'day_quota') {
    return new ChatProviderError('day_quota', 429, { scope: 'day_quota', retryAfterSeconds: null });
  }
  if (fault === 'auth') return new ChatProviderError('auth', 401, { scope: 'auth' });
  if (fault === 'server') return new ChatProviderError('server', 502, { scope: 'server' });
  if (fault === 'timeout') return new ChatProviderError('timeout', 504, { scope: 'timeout' });
  return null;
}

export async function* streamMock({ fault, signal, slowMs = 8000 } = {}) {
  mockStarts += 1;
  if (!mockChatAllowed()) throw new ChatProviderError('server', 503, { scope: 'server' });
  const early = mockFaultError(fault);
  if (early) throw early;
  const usage = {
    type: 'usage',
    model: 'mock',
    finishReason: 'STOP',
    inputTokens: 11,
    thinkingTokens: 0,
    outputTokens: 5,
  };
  if (fault === 'slow_stream') {
    yield { type: 'text', text: '', model: 'mock' };
    await wait(slowMs, signal);
    yield { type: 'text', text: 'This is a slow mock answer.', model: 'mock' };
    yield usage;
    return;
  }
  if (fault === 'cut_stream') {
    yield { type: 'text', text: 'This answer was cut.', model: 'mock' };
    yield { type: 'cut' };
    return;
  }
  yield { type: 'text', text: 'This is a mock answer.', model: 'mock' };
  yield usage;
}
