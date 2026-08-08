import { useCallback, useEffect, useRef, useState } from 'react';
import {
  aiConfigured,
  formatChatError,
  localKnowledgeReply,
  sanitizeAssistantText,
  streamChatReply,
} from '../lib/ai';

const STATIC_ALWAYS = [
  'What are the biggest caveats of this analysis at N=10?',
];

const SUGGESTION_POOL = [
  "Why did B_V1 go viral when the others didn't?",
  'How is amplification computed for B_V1? Show the numbers.',
  'Which brain networks separate the breakouts from the tail?',
  'What does the hook slope measure, and who has the strongest hook?',
  'From a UGC/content view, what should the next reel copy?',
  "Where does A_V5's peak activation rank among the 10?",
  'Why can a negative hook slope still land in the strong tier?',
  'Compare amplification for B_V1 vs A_V1 in plain words.',
  'What does sustain_ratio tell you about retention in this pack?',
  'Which reel has the weakest hook_slope, and did plays match that?',
  'If you only optimize for like_rate, which reel looks best and why?',
];

const OFFLINE_REPLY =
  "classy isn't listening yet. try one of these instead:";

const NEAR_BOTTOM_PX = 64;
const TEXTAREA_MAX_LINES = 6;

function pickFromPool(seed, count, exclude = []) {
  const ban = new Set(exclude);
  const arr = SUGGESTION_POOL.filter((s) => !ban.has(s));
  let s = (Number(seed) || 0) * 9973 + 11;
  for (let i = arr.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr.slice(0, count);
}

function scrubAwareSuggestions(knowledge, videoId, timeSec) {
  if (!knowledge || !videoId) return [];
  const video = (knowledge.videos || []).find((v) => v.id === videoId);
  const series = video?.activation_timeline?.series;
  if (!Array.isArray(series) || series.length === 0) return [];

  let nearest = series[0];
  let nearestDist = Infinity;
  let peak = series[0];
  let trough = series[0];
  for (const pt of series) {
    const d = Math.abs((pt.t_sec ?? 0) - timeSec);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = pt;
    }
    if ((pt.mean_abs ?? 0) > (peak.mean_abs ?? 0)) peak = pt;
    if ((pt.mean_abs ?? 0) < (trough.mean_abs ?? 0)) trough = pt;
  }

  const tNear = Math.round(nearest.t_sec ?? 0);
  const tPeak = Math.round(peak.t_sec ?? 0);
  const tTrough = Math.round(trough.t_sec ?? 0);
  const dur = video.duration ?? video.features?.duration_sec ?? series[series.length - 1]?.t_sec ?? 0;
  const nearPeak = Math.abs((nearest.t_sec ?? 0) - (peak.t_sec ?? 0)) <= 1.25;
  const nearEnd =
    dur > 0 && (nearest.t_sec ?? 0) >= dur * 0.7 && (nearest.mean_abs ?? 0) <= (peak.mean_abs ?? 0) * 0.92;

  const chips = [`what's happening around second ${tNear} in ${videoId}?`];

  if (nearPeak) {
    chips.push(`why does activation peak near second ${tPeak} in ${videoId}?`);
  } else if (nearEnd) {
    chips.push(`why does activation dip near the end of ${videoId}?`);
  } else {
    chips.push(
      `how does activation at second ${tNear} compare to ${videoId}'s peak at second ${tPeak}?`,
    );
  }

  if (tTrough !== tPeak && tTrough !== tNear && chips.length < 3) {
    chips.push(`why does activation dip around second ${tTrough} in ${videoId}?`);
  }

  return chips.slice(0, 3);
}

function buildVisibleSuggestions(knowledge, viewMoment, seed) {
  const scrub = scrubAwareSuggestions(
    knowledge,
    viewMoment?.videoId,
    Number(viewMoment?.timeSec) || 0,
  );
  if (scrub.length === 0) {
    return [...STATIC_ALWAYS, ...pickFromPool(seed, 2, STATIC_ALWAYS)].slice(0, 3);
  }
  const staticExtra = pickFromPool(seed, 1, STATIC_ALWAYS);
  return [...scrub.slice(0, 2), ...STATIC_ALWAYS, ...staticExtra].slice(0, 4);
}

export default function ChatPanel({
  knowledge,
  viewMoment = null,
  collapsed = false,
  focused = false,
  mobile = false,
  onToggleCollapse,
  onToggleFocus,
  onCloseMobile,
}) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [showOfflineHints, setShowOfflineHints] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState(null);
  const [suggestSeed, setSuggestSeed] = useState(0);
  const scrollRef = useRef(null);
  const textareaRef = useRef(null);
  const stickRef = useRef(true);
  const visibleSuggestions = buildVisibleSuggestions(knowledge, viewMoment, suggestSeed);
  const chatReady = Boolean(knowledge && aiConfigured);

  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const styles = getComputedStyle(el);
    const lineHeight = parseFloat(styles.lineHeight) || 20;
    const padY = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom) || 0;
    const maxH = lineHeight * TEXTAREA_MAX_LINES + padY;
    el.style.height = `${Math.min(el.scrollHeight, maxH)}px`;
    el.style.overflowY = el.scrollHeight > maxH ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    resizeTextarea();
  }, [input, resizeTextarea]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const near = dist <= NEAR_BOTTOM_PX;
    stickRef.current = near;
    setShowJump(!near && (busy || messages.length > 0));
  }, [busy, messages.length]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickRef.current) {
      el.scrollTop = el.scrollHeight;
      setShowJump(false);
    } else {
      setShowJump(true);
    }
  }, [messages, showOfflineHints, busy]);

  function jumpToLatest() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickRef.current = true;
    setShowJump(false);
  }

  async function clearChat() {
    if (busy) return;
    setMessages([]);
    setShowOfflineHints(false);
    setInput('');
    setShowJump(false);
    setSuggestSeed(0);
    stickRef.current = true;
  }

  async function copyMessage(text, idx) {
    try {
      await navigator.clipboard.writeText(text || '');
      setCopiedIdx(idx);
      window.setTimeout(() => setCopiedIdx((cur) => (cur === idx ? null : cur)), 1200);
    } catch {
      /* ignore */
    }
  }

  async function send(text) {
    const q = (text ?? input).trim();
    if (!q || busy) return;
    setInput('');
    setShowOfflineHints(false);
    stickRef.current = true;
    setShowJump(false);
    const priorMessages = messages;
    setMessages((m) => [...m, { role: 'user', text: q }, { role: 'model', text: '' }]);
    if (!chatReady) {
      setMessages((m) => {
        const copy = [...m];
        copy[copy.length - 1] = {
          role: 'model',
          text: OFFLINE_REPLY,
        };
        return copy;
      });
      setShowOfflineHints(true);
      setSuggestSeed((n) => n + 1);
      return;
    }
    setBusy(true);
    try {
      let acc = '';
      let usedModel = null;
      for await (const event of streamChatReply({
        knowledge,
        priorMessages,
        message: q,
      })) {
        if (event.type === 'meta') {
          usedModel = event.model;
          setMessages((m) => {
            const copy = [...m];
            copy[copy.length - 1] = {
              role: 'model',
              text: acc ? sanitizeAssistantText(acc) : '',
              model: usedModel,
            };
            return copy;
          });
          continue;
        }
        acc += event.text || '';
        const cleaned = sanitizeAssistantText(acc);
        setMessages((m) => {
          const copy = [...m];
          copy[copy.length - 1] = {
            role: 'model',
            text: cleaned,
            model: usedModel,
          };
          return copy;
        });
      }
      const finalText = sanitizeAssistantText(acc);
      setMessages((m) => {
        const copy = [...m];
        copy[copy.length - 1] = {
          role: 'model',
          text: finalText,
          model: usedModel,
        };
        return copy;
      });
    } catch (err) {
      console.error('[ask classy]', err);
      const apiMsg = formatChatError(err);
      const bothQuota =
        err?.code === 'BOTH_MODELS_QUOTA' || err?.name === 'BothModelsQuotaError';
      let text = apiMsg;
      if (!bothQuota && knowledge) {
        const local = localKnowledgeReply(knowledge, q);
        text = `${apiMsg}\n\nfallback from local data:\n${local}`;
      }
      setMessages((m) => {
        const copy = [...m];
        copy[copy.length - 1] = {
          role: 'model',
          text,
          error: true,
        };
        return copy;
      });
    } finally {
      setBusy(false);
      setSuggestSeed((n) => n + 1);
    }
  }

  function onKeyDown(e) {
    if (mobile) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  if (collapsed && !mobile && !focused) {
    return (
      <div className="chat-rail h-full flex flex-col items-center py-3 gap-3">
        <button
          type="button"
          className="chat-icon-btn"
          onClick={onToggleCollapse}
          title="Expand ask classy"
          aria-label="Expand ask classy"
          aria-expanded={false}
        >
          [»
        </button>
        <button
          type="button"
          className="chat-icon-btn"
          onClick={onToggleFocus}
          title="Focus ask classy"
          aria-label="Focus ask classy"
        >
          ▣
        </button>
        <div className="chat-rail-label" aria-hidden>
          ask
        </div>
      </div>
    );
  }

  const empty = messages.length === 0;

  return (
    <div className="flex flex-col h-full min-h-0 relative">
      <div
        className="chat-header px-4 py-3 border-b hairline flex items-start justify-between gap-3"
        style={{ background: 'var(--bg-subtle)' }}
      >
        <div className="min-w-0">
          <div className="chat-title tracking-[0.04em]">ask classy</div>
          <div className="chat-subtitle text-[11px] tracking-[0.05em] mt-1">
            {aiConfigured ? 'grounded in the reel dataset' : "classy isn't listening yet"}
          </div>
        </div>
        <div className="chat-header-actions shrink-0">
          {messages.length > 0 && (
            <button
              type="button"
              className="chat-text-btn"
              onClick={clearChat}
              disabled={busy}
              title="Clear chat"
              aria-label="Clear chat"
            >
              clear chat
            </button>
          )}
          <div className="chat-header-icons">
            {mobile ? (
              <button
                type="button"
                className="chat-icon-btn"
                onClick={onCloseMobile}
                title="Close ask classy"
                aria-label="Close ask classy"
              >
                ×
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="chat-icon-btn"
                  onClick={onToggleFocus}
                  title={focused ? 'Exit focus mode' : 'Focus ask classy'}
                  aria-label={focused ? 'Exit focus mode' : 'Focus ask classy'}
                  aria-pressed={focused}
                >
                  {focused ? '◻' : '▣'}
                </button>
                {!focused && (
                  <button
                    type="button"
                    className="chat-icon-btn"
                    onClick={onToggleCollapse}
                    title="Collapse ask classy"
                    aria-label="Collapse ask classy"
                    aria-expanded={true}
                  >
                    «]
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollRef}
          className={`chat-thread${empty ? ' chat-thread-empty' : ''}`}
          onScroll={onScroll}
        >
          {empty && (
            <div className="chat-suggest-list">
              <div
                className="section-label chat-suggest-label"
                style={{ color: 'var(--text-secondary)' }}
              >
                try one of these
              </div>
              {visibleSuggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => send(s)}
                  className="text-left text-[13px] px-3 py-2.5 suggest-chip leading-snug"
                  style={{ color: 'var(--text-primary)' }}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          {messages.map((msg, i) => {
            const isModel = msg.role === 'model';
            const isStreamingTail = busy && i === messages.length - 1 && isModel;
            const showThinking = isStreamingTail && !msg.text;
            const body = msg.text || '…';
            return (
              <div
                key={i}
                className={`chat-row ${isModel ? 'chat-row-model' : 'chat-row-user'}`}
              >
                <div
                  className={`chat-bubble whitespace-pre-wrap text-[13px] leading-relaxed ${
                    isModel ? 'chat-bubble-model' : 'chat-bubble-user px-3 py-2'
                  }`}
                >
                  {showThinking ? (
                    <span className="chat-thinking" aria-live="polite" aria-label="Generating reply">
                      <span className="chat-thinking-pulse" aria-hidden />
                      thinking
                    </span>
                  ) : (
                    body
                  )}
                  {isModel && msg.model && !msg.error && (msg.text || isStreamingTail) && (
                    <div className="chat-model-tag" title={`Model ${msg.model}`}>
                      {msg.model}
                    </div>
                  )}
                  {isModel && msg.text && !isStreamingTail && (
                    <button
                      type="button"
                      className="chat-copy-btn"
                      onClick={() => copyMessage(msg.text, i)}
                      title={copiedIdx === i ? 'copied' : 'copy'}
                      aria-label={copiedIdx === i ? 'Copied' : 'Copy message'}
                    >
                      {copiedIdx === i ? 'ok' : '[]'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {showOfflineHints && (
            <div className="chat-suggest-list">
              {visibleSuggestions.map((s) => (
                <button
                  key={'hint-' + s}
                  type="button"
                  onClick={() => send(s)}
                  className="text-left text-[13px] px-3 py-2.5 suggest-chip leading-snug"
                  style={{ color: 'var(--text-primary)' }}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          {!empty && !busy && !showOfflineHints && (
            <div className="chat-suggest-list">
              <div
                className="section-label chat-suggest-label"
                style={{ color: 'var(--text-secondary)' }}
              >
                try one of these
              </div>
              {visibleSuggestions.map((s) => (
                <button
                  key={'next-' + suggestSeed + '-' + s}
                  type="button"
                  onClick={() => send(s)}
                  className="text-left text-[13px] px-3 py-2.5 suggest-chip leading-snug"
                  style={{ color: 'var(--text-primary)' }}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>

        {showJump && (
          <button
            type="button"
            className="chat-jump-btn"
            onClick={jumpToLatest}
            title="Jump to latest"
            aria-label="Jump to latest messages"
          >
            ↓ latest
          </button>
        )}
      </div>

      <div
        className={`chat-composer border-t hairline${mobile ? ' is-mobile' : ''}`}
        style={{ background: 'var(--bg-subtle)' }}
      >
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          enterKeyHint={mobile ? 'enter' : 'send'}
          placeholder={
            mobile ? 'ask me something…' : 'ask me something… ↵ send · ⇧↵ newline'
          }
          className="w-full input-field text-[13px] chat-input"
          aria-label={
            mobile
              ? 'Message ask classy. Return for a new line, Send to submit.'
              : 'Message ask classy. Enter to send, Shift+Enter for newline'
          }
        />
        <button
          type="button"
          onClick={() => send()}
          disabled={busy || !input.trim()}
          className="chat-send-btn btn-primary text-[13px]"
          title="Send message"
        >
          Send
        </button>
      </div>
    </div>
  );
}
