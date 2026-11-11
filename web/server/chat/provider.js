import { streamAnthropic } from './anthropicProvider.js';
import { streamGemini } from './geminiProvider.js';
import { mockChatAllowed, streamMock } from './mock.js';
import { ChatProviderError } from './providerError.js';

export { ChatProviderError };

export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';

export function resolveChatConfig(env = process.env) {
  const requested = String(env.CHAT_PROVIDER || 'gemini').trim().toLowerCase();
  if (requested === 'mock' && mockChatAllowed(env)) {
    return { provider: 'mock', model: 'mock', apiKey: 'mock' };
  }
  const provider = requested === 'anthropic' ? 'anthropic' : 'gemini';
  const model =
    String(env.CHAT_MODEL || '').trim() ||
    (provider === 'anthropic' ? env.CLASSY_MODEL || 'claude-opus-5' : DEFAULT_GEMINI_MODEL);
  const apiKey = provider === 'anthropic' ? env.ANTHROPIC_API_KEY || '' : env.GEMINI_CHAT_API_KEY || '';
  return { provider, model, apiKey };
}

export async function* streamProvider(config, args) {
  if (config.provider === 'mock') {
    if (!mockChatAllowed()) throw new ChatProviderError('server', 503, { scope: 'server' });
    yield* streamMock(args);
    return;
  }
  if (!config?.apiKey) throw new ChatProviderError('missing_key', 0);
  if (config.provider === 'anthropic') {
    yield* streamAnthropic({ ...args, apiKey: config.apiKey, model: config.model, fallbackModel: '' });
    return;
  }
  yield* streamGemini({ ...args, apiKey: config.apiKey, model: config.model });
}
