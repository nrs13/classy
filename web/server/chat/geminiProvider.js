import { classifyProviderFailure } from './classify.js';
import { ChatProviderError } from './providerError.js';

// GenerateContent usageMetadata: https://ai.google.dev/gemini-api/docs/tokens
// Candidate.finishReason: https://ai.google.dev/api/generate-content#FinishReason

function failureError(status, raw, kind) {
  const failure = classifyProviderFailure(status, raw, kind);
  return new ChatProviderError(failure.scope, failure.status, failure);
}

function tokenCount(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function cleanFinishReason(value) {
  return String(value || '').replace(/[^\w]/g, '').slice(0, 40);
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
  let finishReason = '';
  let inputTokens = null;
  let thinkingTokens = null;
  let outputTokens = null;
  const note = (payload) => {
    const reason = cleanFinishReason(payload?.candidates?.[0]?.finishReason);
    if (reason) finishReason = reason;
    const usage = payload?.usageMetadata;
    if (!usage || typeof usage !== 'object') return;
    const input = tokenCount(usage.promptTokenCount);
    const output = tokenCount(usage.candidatesTokenCount);
    const thinking = tokenCount(usage.thoughtsTokenCount);
    if (input != null) inputTokens = input;
    if (output != null) outputTokens = output;
    if (thinking != null) thinkingTokens = thinking;
  };
  const usageEvent = () => ({
    type: 'usage',
    model,
    finishReason,
    inputTokens,
    thinkingTokens,
    outputTokens,
  });
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
        generationConfig: {
          maxOutputTokens,
          // thinkingConfig.thinkingLevel: https://ai.google.dev/gemini-api/docs/thinking
          thinkingConfig: { thinkingLevel: 'minimal' },
        },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const raw = await res.text();
      throw failureError(res.status, raw);
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
        note(payload);
        const parts = payload?.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
          if (typeof part.text === 'string' && part.text) yield { type: 'text', text: part.text, model };
        }
      }
    }
    yield usageEvent();
  } catch (err) {
    if (finishReason || inputTokens != null || thinkingTokens != null || outputTokens != null) {
      yield usageEvent();
    }
    if (err instanceof ChatProviderError) throw err;
    if (signal?.aborted) {
      const aborted = new Error('aborted');
      aborted.name = 'AbortError';
      aborted.code = 'ABORTED';
      throw aborted;
    }
    if (controller.signal.aborted || err?.name === 'AbortError') throw failureError(504, '', 'timeout');
    throw failureError(0, '', 'network');
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
