import { getApp, getApps, initializeApp } from 'firebase/app';
import { getAI, getGenerativeModel, GoogleAIBackend } from 'firebase/ai';
import { firebaseConfig } from '../firebaseConfig';

// Free-tier quota is per model per day. Prefer flash-lite for demos.
export const MODEL = 'gemini-3.5-flash-lite';

export const aiConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);

function getFirebaseApp() {
  return getApps().length ? getApp() : initializeApp(firebaseConfig);
}

function errText(err) {
  if (err == null) return 'unknown error';
  if (typeof err === 'string') return err;
  const parts = [
    err.message,
    err.code,
    err.status,
    err.customErrorData && JSON.stringify(err.customErrorData),
    err.cause && (err.cause.message || String(err.cause)),
    String(err),
  ];
  return parts.filter(Boolean).join(' ');
}

export function isQuotaError(err) {
  const text = errText(err).toLowerCase();
  return (
    text.includes('429') ||
    text.includes('resource_exhausted') ||
    text.includes('quota exceeded') ||
    text.includes('rate limit') ||
    text.includes('too many requests') ||
    text.includes('free_tier') ||
    text.includes('exceeded your current quota')
  );
}

// Map API errors to short chat copy.
export function formatChatError(err) {
  const text = errText(err);
  const lower = text.toLowerCase();

  if (isQuotaError(err)) {
    if (
      lower.includes('perday') ||
      lower.includes('per_day') ||
      lower.includes('free_tier') ||
      lower.includes('generate_content_free_tier') ||
      lower.includes('quotaid')
    ) {
      return 'daily free quota used up for this Gemini model. try tomorrow, switch models, or enable billing in Firebase / Google AI Studio.';
    }
    return 'hit the free rate limit. wait about a minute, then try again.';
  }
  if (
    text.includes('401') ||
    text.includes('403') ||
    lower.includes('permission_denied') ||
    lower.includes('api key') ||
    lower.includes('api_key')
  ) {
    return 'AI auth failed (API key or permissions). check Firebase AI Logic setup.';
  }
  if (text.includes('404') || lower.includes('not found') || lower.includes('no longer available')) {
    return 'that Gemini model is unavailable. update the model id in ai.js.';
  }
  if (lower.includes('app check') || lower.includes('appcheck')) {
    return 'App Check blocked the AI request. relax enforcement or register this app.';
  }
  const clipped = text.replace(/\s+/g, ' ').slice(0, 220);
  return `AI error: ${clipped || 'unknown failure'}`;
}

function systemPreamble(knowledge) {
  return `You are the analyst assistant embedded in "Classy" (tagline: marketing reimagined), a proof-of-concept that runs 10 Instagram study-niche reels through Meta's TRIBE V2 brain-encoding model and relates the predicted brain response to real engagement.

You answer THREE kinds of questions, always grounded in the DATA below:
1. Math/methods: how any feature or metric is computed (plain-text formulas with the actual numbers plugged in).
2. Content-marketing / UGC: why a reel did or didn't resonate, format patterns, hooks, what to replicate.
3. Brain / neuroscience: what the activation means, which networks drive engagement, hemodynamic lag, caveats.

Tone:
- Sharp analyst texting a colleague. Direct, dry, useful.
- No "Great question!", no exclamation points.
- Never use em dashes (—) or en dashes (–) as sentence connectors. Use a period, comma, because, but, and, or parentheses instead.
- No rubric labels like "Gap 1:", "Context from the DATA for X:", "Direct answer:", "Caveat:".

Formatting (strict, because this renders in a plain chat bubble):
- NO LaTeX/math notation ever. Never use $$...$$, $...$, \\frac, \\times, or similar. Write formulas in plain text, e.g. peak = max(activation_t).
- NO markdown headers (###, ##, #).
- NO horizontal rules (--- or ***).
- NO markdown emphasis at all: never use **bold**, __bold__, *italic*, _italic_, or backtick code spans. Plain text only. Write numbers as bare digits (e.g. 6546346 or 6,546,346) with no asterisks.
- Minimal structure: either 1-3 short paragraphs OR a short plain list, not both with headers.
- No ASCII bar charts, sparklines, or pseudo-graphs. Use plain-language comparisons. If a visual would help, ask: "want me to pull this up as a chart?"

Answer shape (normal questions):
1. Direct answer first: one line, plain language, lead with the number/fact.
2. Then 1-2 sentences of context grounded in DATA.
3. Optional: one line on a contradiction or tension if relevant.
4. Optional closer: either one caveat OR one actionable suggestion, not both unless the user asked for deep analysis.
Target 3-6 sentences. Go longer only if they ask for a full breakdown, table or "explain everything."

Multi-part questions:
- If the user asks 5+ distinct parts, answer only the most important 2-3 concisely, then say to ask about the rest one at a time.
- Never end mid-word, mid-list, or mid-sentence. If space is tight, finish the current point cleanly and stop.

Other rules:
- Ground every claim in the DATA. If a number is missing, say so plainly.
- This is N=10, a proof of concept. Never claim statistical significance; frame comparisons as descriptive/exploratory.
- Be concise and concrete. Prefer real numbers from the DATA over generic advice.

DATA (JSON):
${JSON.stringify(knowledge)}`;
}

// Strip markdown/math so chat stays plain text.
export function sanitizeAssistantText(text) {
  if (text == null || text === '') return text;
  let out = String(text);

  out = out.replace(/[\u2217\u204E\u2731\uFF0A\u066D]/g, '*');
  out = out.replace(/[\uFF3F\u02CD]/g, '_');

  out = out.replace(/\$\$[\s\S]*?\$\$/g, (block) => {
    const inner = block.slice(2, -2).trim();
    return inner.replace(/\\[a-zA-Z]+\{?([^}]*)\}?/g, '$1').replace(/[{}]/g, '');
  });
  out = out.replace(/\$([^$\n]+?)\$/g, '$1');

  out = out.replace(/^#{1,6}\s+/gm, '');
  out = out.replace(/^\s*([-*_]){3,}\s*$/gm, '');
  out = out.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, inner) => inner.trim());
  out = out.replace(/\*{1,3}\s*([\d][\d,.\s]*[%×xX]?)\s*\*{1,3}/g, '$1');

  let prev;
  do {
    prev = out;
    out = out.replace(/\*\*\*([\s\S]+?)\*\*\*/g, '$1');
    out = out.replace(/\*\*([\s\S]+?)\*\*/g, '$1');
    out = out.replace(/___([\s\S]+?)___/g, '$1');
    out = out.replace(/__([\s\S]+?)__/g, '$1');
  } while (out !== prev);

  out = out.replace(/\*{2,}/g, '');
  out = out.replace(/_{2,}/g, '');

  do {
    prev = out;
    out = out.replace(/(^|[\s(])\*([^*\n]+?)\*([\s).,!?:;]|$)/g, '$1$2$3');
  } while (out !== prev);

  do {
    prev = out;
    out = out.replace(/(^|[\s(])_([^_\n]+?)_([\s).,!?:;]|$)/g, '$1$2$3');
  } while (out !== prev);

  out = out.replace(/\*+(?=[\w\d])/g, '');
  out = out.replace(/(?<=[\w\d])\*+/g, '');
  out = out.replace(/`([^`\n]+)`/g, '$1');
  out = out.replace(/`+/g, '');

  out = out.replace(/\s*[\u2014\u2013]\s*/g, '. ');
  out = out.replace(/\.\s*\./g, '.');
  out = out.replace(/[ \t]+\n/g, '\n');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

function fmtNum(n) {
  if (n == null || Number.isNaN(Number(n))) return String(n);
  return Number(n).toLocaleString('en-US');
}

/** Deterministic offline answer from knowledge.json when Gemini is dead. */
export function localKnowledgeReply(knowledge, question) {
  const videos = knowledge?.videos;
  if (!Array.isArray(videos) || videos.length === 0) {
    return 'local fallback: no knowledge.json videos loaded.';
  }
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
      `local mode (Gemini unavailable): ${v.id} amplification = plays/followers = ${fmtNum(m.plays)} / ${fmtNum(m.followers)} = ${m.amplification}.`,
      `that is reach relative to account size; breakouts sit far above the rest of this N=10 set.`,
      `caveat: exploratory only at N=10.`,
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
    return [
      'local mode: this pack stores cortex-wide |activation| summaries (mean_abs_activation, peak_mean_abs, sustain_ratio), not per-network ROI tables in knowledge.json.',
      top
        ? `${top.id} leads amplification at ${top.metrics?.amplification} with sustain_ratio ${top.features?.sustain_ratio}.`
        : '',
      'for network maps, open the brain viewer on a selected reel. N=10 exploratory only.',
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
      'Gemini is down/quota-limited; this answer is computed from knowledge.json only.',
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
    'local mode (Gemini unavailable): top amplification in this N=10 pack:',
    ...lines,
    'ask about a specific id (e.g. B_V1) for numbers. enable billing or wait for free-tier reset for full AI answers.',
  ].join(' ');
}

export function createChat(knowledge) {
  if (!aiConfigured) return null;
  const app = getFirebaseApp();
  const ai = getAI(app, { backend: new GoogleAIBackend() });
  const model = getGenerativeModel(ai, {
    model: MODEL,
    systemInstruction: systemPreamble(knowledge),
    generationConfig: { temperature: 0.4, topP: 0.95, maxOutputTokens: 4096 },
  });
  return model.startChat();
}

export async function* streamReply(chat, message) {
  const result = await chat.sendMessageStream(message);
  let got = false;
  for await (const chunk of result.stream) {
    let piece = '';
    try {
      piece = chunk.text();
    } catch (e) {
      if (!got) throw e;
      continue;
    }
    if (piece) {
      got = true;
      yield piece;
    }
  }
  if (!got) {
    throw new Error('empty model response (no text candidates)');
  }
}
