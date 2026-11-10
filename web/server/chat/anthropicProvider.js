import Anthropic from '@anthropic-ai/sdk';
import { ChatProviderError } from './providerError.js';

export async function* streamAnthropic({
  apiKey,
  model,
  fallbackModel = '',
  system,
  messages,
  maxOutputTokens,
  signal,
}) {
  if (!apiKey) throw new ChatProviderError('missing_key', 0);
  const client = new Anthropic({ apiKey });
  const chain = fallbackModel && fallbackModel !== model ? [model, fallbackModel] : [model];
  for (let i = 0; i < chain.length; i += 1) {
    const current = chain[i];
    let announced = false;
    try {
      const stream = client.messages.stream(
        {
          model: current,
          max_tokens: maxOutputTokens,
          ...(current.startsWith('claude-haiku')
            ? {}
            : { output_config: { effort: process.env.CLASSY_EFFORT || 'low' } }),
          system: [
            {
              type: 'text',
              text: system,
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages,
        },
        signal ? { signal } : undefined,
      );
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          announced = true;
          yield { type: 'text', text: event.delta.text, model: current };
        }
      }
      const final = await stream.finalMessage();
      yield { type: 'usage', model: current, usage: final.usage };
      if (final.stop_reason === 'refusal') yield { type: 'refusal' };
      return;
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) {
        const aborted = new Error('aborted');
        aborted.name = 'AbortError';
        aborted.code = 'ABORTED';
        throw aborted;
      }
      const isQuota = err instanceof Anthropic.RateLimitError || err?.status === 429;
      if (isQuota && i < chain.length - 1 && !announced) continue;
      const errorType = isQuota ? 'quota' : err?.status === 401 || err?.status === 403 ? 'auth' : 'server';
      throw new ChatProviderError(errorType, err?.status || 0);
    }
  }
}
