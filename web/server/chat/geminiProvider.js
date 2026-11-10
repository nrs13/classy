import { ChatProviderError } from './providerError.js';

function classifyGemini(status, raw) {
  const text = String(raw || '').toLowerCase();
  if (status === 401 || status === 403) return 'auth';
  if (status === 429 || text.includes('resource_exhausted') || text.includes('quota')) return 'quota';
  if (status >= 500) return 'server';
  return 'api';
}

export async function* streamGemini({
  apiKey,
  model,
  system,
  messages,
  maxOutputTokens,
  signal,
  timeoutMs = 0,
  fetchImpl = fetch,
}) {
  if (!apiKey) throw new ChatProviderError('missing_key', 0);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: (messages || []).map((message) => ({
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: message.content }],
        })),
        generationConfig: { maxOutputTokens },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const raw = await res.text();
      throw new ChatProviderError(classifyGemini(res.status, raw), res.status);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      if (signal?.aborted) {
        const aborted = new Error('aborted');
        aborted.name = 'AbortError';
        aborted.code = 'ABORTED';
        throw aborted;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const json = trimmed.slice(5).trim();
        if (!json || json === '[DONE]') continue;
        let payload;
        try {
          payload = JSON.parse(json);
        } catch {
          continue;
        }
        const parts = payload?.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
          if (typeof part.text === 'string' && part.text) yield { type: 'text', text: part.text, model };
        }
      }
    }
  } catch (err) {
    if (err instanceof ChatProviderError || err?.name === 'AbortError') throw err;
    if (signal?.aborted) {
      const aborted = new Error('aborted');
      aborted.name = 'AbortError';
      aborted.code = 'ABORTED';
      throw aborted;
    }
    if (controller.signal.aborted) throw new ChatProviderError('timeout', 504);
    throw new ChatProviderError('server', 0);
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
