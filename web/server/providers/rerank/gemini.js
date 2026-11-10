const MAX_CANDIDATES = 20;

export function createGeminiRerank(env = process.env, overrides = {}) {
  const key = env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '';
  const model = env.CLASSY_RERANK_MODEL || 'gemini-2.5-flash';
  const timeoutMs = Number(env.CLASSY_RERANK_TIMEOUT_MS || 1500);
  const fetchImpl = overrides.fetch || fetch;

  return {
    name: 'gemini',
    async rerank(query, candidates) {
      if (!key || candidates.length < 2) return candidates;
      const head = candidates.slice(0, MAX_CANDIDATES);
      const tail = candidates.slice(MAX_CANDIDATES);
      const lines = head.map((c, i) => `${i}: ${String(c.best?.quote || '').slice(0, 300)}`).join('\n');
      try {
        const response = await fetchImpl(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    {
                      text: `Query: ${query}\nCandidates:\n${lines}\nReturn a JSON array of candidate numbers, most relevant first. Include every number once.`,
                    },
                  ],
                },
              ],
              generationConfig: { responseMimeType: 'application/json', temperature: 0 },
            }),
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
        if (!response.ok) return candidates;
        const payload = await response.json();
        const order = JSON.parse(payload?.candidates?.[0]?.content?.parts?.[0]?.text || '[]');
        if (!Array.isArray(order)) return candidates;
        const picked = [];
        const used = new Set();
        for (const n of order) {
          if (Number.isInteger(n) && n >= 0 && n < head.length && !used.has(n)) {
            used.add(n);
            picked.push(head[n]);
          }
        }
        head.forEach((c, i) => {
          if (!used.has(i)) picked.push(c);
        });
        return [...picked, ...tail];
      } catch {
        return candidates;
      }
    },
  };
}
