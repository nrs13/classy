import { datasetSize } from './dataset.js';

export { sanitizeAssistantText } from './sanitizeAssistantText.js';

export async function checkChatBackend() {
  try {
    const res = await fetch('/api/chat', { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

export class BothModelsQuotaError extends Error {
  constructor(message = 'model quota reached, try again later') {
    super(message);
    this.name = 'BothModelsQuotaError';
    this.code = 'BOTH_MODELS_QUOTA';
  }
}

export function formatChatError(err) {
  if (err?.code === 'BOTH_MODELS_QUOTA' || err instanceof BothModelsQuotaError) {
    return 'model quota reached, try again later';
  }
  const text = String(err?.message || err || 'unknown error');
  if (err?.code === 'NOT_CONFIGURED' || text.includes('503')) {
    return 'no Anthropic API key configured on the server yet.';
  }
  if (err?.code === 'NO_BACKEND' || text.includes('404')) {
    return 'chat backend unreachable. it runs on the deployed site (or locally via `vercel dev`), not plain `npm run dev`.';
  }
  if (text.includes('401') || text.includes('403') || text.toLowerCase().includes('api key')) {
    return 'AI auth failed (API key invalid or revoked). check the ANTHROPIC_API_KEY on Vercel.';
  }
  const clipped = text.replace(/\s+/g, ' ').slice(0, 220);
  return `AI error: ${clipped || 'unknown failure'}`;
}

function fmtNum(n) {
  if (n == null || Number.isNaN(Number(n))) return String(n);
  return Number(n).toLocaleString('en-US');
}

export function localKnowledgeReply(knowledge, question) {
  const videos = knowledge?.videos;
  if (!Array.isArray(videos) || videos.length === 0) {
    return 'local fallback: no knowledge.json videos loaded.';
  }
  const n = datasetSize(videos);
  const q = String(question || '').toLowerCase();
  const byAmp = [...videos].sort(
    (a, b) => (b.metrics?.amplification ?? 0) - (a.metrics?.amplification ?? 0),
  );
  const top = byAmp[0];
  const idMatch = q.match(/\b([ab]_[a-z]?\d+)\b/i);
  const mentioned = idMatch
    ? videos.find((v) => v.id.toLowerCase() === idMatch[1].toLowerCase())
    : null;

  if (q.includes('amplification') && (mentioned || q.includes('b_v1'))) {
    const v = mentioned || videos.find((x) => x.id === 'B_V1') || top;
    const m = v.metrics || {};
    return [
      `local mode (AI unavailable): ${v.id} amplification = plays/followers = ${fmtNum(m.plays)} / ${fmtNum(m.followers)} = ${m.amplification}.`,
      `that is reach relative to account size; breakouts sit far above the rest of this N=${n} set.`,
      `caveat: exploratory only at N=${n}.`,
    ].join(' ');
  }

  if (q.includes('hook')) {
    const ranked = [...videos].sort(
      (a, b) => (b.features?.hook_slope ?? -Infinity) - (a.features?.hook_slope ?? -Infinity),
    );
    const best = ranked[0];
    const v = mentioned || best;
    return [
      `local mode: strongest hook_slope in-pack is ${best.id} at ${best.features?.hook_slope}.`,
      mentioned
        ? `${mentioned.id} hook_slope is ${mentioned.features?.hook_slope}.`
        : `hook_slope = slope of mean_|act|(t) for t ≤ 3.0s.`,
      v?.annotations?.relatability_hook
        ? `content note for ${v.id}: ${v.annotations.relatability_hook}`
        : '',
    ]
      .filter(Boolean)
      .join(' ');
  }

  if (q.includes('network') || q.includes('brain')) {
    const net = mentioned?.networks || top?.networks;
    const ranks = Array.isArray(net?.top) ? net.top.join(', ') : null;
    return [
      'local mode: each reel has Yeo-7 cortical network means, a top-3 rank, and peak_t_sec in knowledge.json.',
      mentioned && ranks
        ? `${mentioned.id} top networks: ${ranks}.`
        : top && ranks
          ? `${top.id} top networks: ${ranks}.`
          : '',
      top
        ? `${top.id} leads amplification at ${top.metrics?.amplification} with sustain_ratio ${top.features?.sustain_ratio}.`
        : '',
      `N=${n} exploratory only.`,
    ]
      .filter(Boolean)
      .join(' ');
  }

  if (q.includes('viral') || q.includes('breakout') || q.includes("didn't") || q.includes('b_v1')) {
    const v = mentioned || videos.find((x) => x.id === 'B_V1') || top;
    const m = v.metrics || {};
    const f = v.features || {};
    const a = v.annotations || {};
    return [
      `local mode: ${v.id} is the breakout. ${fmtNum(m.plays)} plays from ${fmtNum(m.followers)} followers (amplification ${m.amplification}).`,
      `format: ${a.format || 'n/a'}; sustain_ratio ${f.sustain_ratio}; hook_slope ${f.hook_slope}.`,
      a.relatability_hook || a.key_elements || '',
      'the AI backend is down or unconfigured; this answer is computed from knowledge.json only.',
    ]
      .filter(Boolean)
      .join(' ');
  }

  if (mentioned) {
    const m = mentioned.metrics || {};
    const f = mentioned.features || {};
    return [
      `local mode: ${mentioned.id} (${mentioned.tier}). plays ${fmtNum(m.plays)}, likes ${fmtNum(m.likes)}, amplification ${m.amplification}, like_rate ${m.like_rate}.`,
      `brain features: hook_slope ${f.hook_slope}, peak_mean_abs ${f.peak_mean_abs}, sustain_ratio ${f.sustain_ratio}.`,
      mentioned.annotations?.format ? `format: ${mentioned.annotations.format}.` : '',
    ]
      .filter(Boolean)
      .join(' ');
  }

  const lines = byAmp.slice(0, 3).map((v, i) => {
    const m = v.metrics || {};
    return `${i + 1}) ${v.id}: amp ${m.amplification}, plays ${fmtNum(m.plays)}, sustain ${v.features?.sustain_ratio}`;
  });
  return [
    `local mode (AI unavailable): top amplification in this N=${n} pack:`,
    ...lines,
    'ask about a specific id (e.g. B_V1) for numbers once the AI backend is configured.',
  ].join(' ');
}

export async function* streamChatReply({ priorMessages = [], message, focus = null }) {
  const history = priorMessages
    .filter((m) => m?.text && (m.role === 'user' || m.role === 'assistant') && !m.error)
    .map((m) => ({ role: m.role, text: String(m.text) }));

  let response;
  try {
    response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history, focus }),
    });
  } catch (err) {
    const wrapped = new Error(`chat request failed: ${err?.message || err}`);
    wrapped.code = 'NO_BACKEND';
    throw wrapped;
  }

  if (!response.ok) {
    const err = new Error(`chat backend error (${response.status})`);
    if (response.status === 503) err.code = 'NOT_CONFIGURED';
    if (response.status === 404) err.code = 'NO_BACKEND';
    throw err;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      let event;
      try {
        event = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      if (event.type === 'meta' || event.type === 'text') {
        yield event;
      } else if (event.type === 'error') {
        if (event.code === 'quota') throw new BothModelsQuotaError();
        throw new Error(event.message || 'AI error');
      } else if (event.type === 'done') {
        return;
      }
    }
  }
}
