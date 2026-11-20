import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CANNED_ONLY_REPLY,
  chatPaused,
  checkChatBackend,
  CHAT_PAUSED,
  CHAT_PRIVACY,
  formatChatError,
  sanitizeAssistantText,
  streamChatReply,
} from '../lib/ai';
import { buildSalientSuggestions } from '../lib/suggestedQuestions';
import {
  DEFAULT_REPLY_MODES,
  REPLY_MODES,
  replyModePlaceholder,
  replyModeSummary,
  toggleReplyMode,
} from '../lib/replyModes';
import ReplyModeGroup from './ReplyModeGroup';
import { acceptSend, capMessage, CHAT_COOLDOWN_MS, composerHold, dropUnfinishedReply, retryTurn } from '../lib/chatLimits';
import { applyOnlineState } from '../lib/connection';
import { coolingDeadline, isCooling, LIVE_REGION, onQuotaClock, quotaAnnouncement, startCountdown } from '../lib/quota';
import { CUT_LABEL, OFFLINE_LABEL } from '../lib/streamFrame';
import { canAsk } from '../lib/answerSubject';

function visitorModel(name) {
  const text = String(name || '').trim();
  if (!text || /gemini|azure|video indexer|content understanding|^mock$/i.test(text)) return '';
  return text;
}

const NEAR_BOTTOM_PX = 64;
const TEXTAREA_MAX_LINES = 6;

export default function ChatPanel({
  knowledge,
  viewMoment = null,
  suggestionVideoIds = [],
  collapsed = false,
  mobile = false,
  onToggleCollapse,
  onCloseMobile,
  mode = 'explore',
  reels = [],
}) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [showOfflineHints, setShowOfflineHints] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState(null);
  const [suggestSeed, setSuggestSeed] = useState(0);
  const [chatState, setChatState] = useState(null);
  const [replyModes, setReplyModes] = useState(DEFAULT_REPLY_MODES);
  const [lensNote, setLensNote] = useState('');
  const [retryArmed, setRetryArmed] = useState(false);
  const scrollRef = useRef(null);
  const textareaRef = useRef(null);
  const stickRef = useRef(true);
  const chatAbort = useRef(null);
  const paintedRef = useRef('');
  const targetRef = useRef('');
  const paceRaf = useRef(0);
  const modelRef = useRef('');
  const lastSentAt = useRef(0);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [cooldownLeft, setCooldownLeft] = useState(0);
  const [quota, setQuota] = useState(null);
  const [quotaLeft, setQuotaLeft] = useState(0);
  const [offline, setOffline] = useState(() => (typeof navigator !== 'undefined' ? !navigator.onLine : false));
  const idemKey = useRef('');
  const sendGen = useRef(0);
  const busyRef = useRef(false);
  const suggestionKey = suggestionVideoIds.join('|');
  const clipSeen = useRef(suggestionKey);

  const toggleMode = useCallback((id) => {
    const next = toggleReplyMode(replyModes, id);
    const mode = REPLY_MODES.find((item) => item.id === id);
    if (mode && next.includes(id) !== replyModes.includes(id)) {
      setLensNote(`${mode.label} is ${next.includes(id) ? 'on' : 'off'}.`);
    }
    setReplyModes(next);
  }, [replyModes]);

  useEffect(() => {
    if (!quota) return undefined;
    if (!isCooling(quota.scope)) {
      const until = Date.parse(quota.resetAt || '');
      if (!Number.isFinite(until)) return undefined;
      const release = () => {
        setQuota(null);
        checkChatBackend().then((status) => {
          setChatState(status);
          if (status.state === 'exhausted') {
            setQuota({ scope: 'own_daily_cap', resetAt: status.resetAt, retryAfterSeconds: null });
          }
        });
      };
      const look = () => {
        if (!onQuotaClock({ until, now: Date.now(), visibility: document.visibilityState, reason: 'timer' })) return;
        release();
      };
      const onVisible = () => {
        if (!onQuotaClock({ until, now: Date.now(), visibility: document.visibilityState, reason: 'visible' })) return;
        release();
      };
      const id = setInterval(look, 1000);
      document.addEventListener('visibilitychange', onVisible);
      return () => {
        clearInterval(id);
        document.removeEventListener('visibilitychange', onVisible);
      };
    }
    const until = coolingDeadline(quota.retryAfterSeconds);
    return startCountdown(until, (left) => {
      setQuotaLeft(left);
      if (left > 0) return;
      setQuota(null);
      checkChatBackend().then(setChatState);
    });
  }, [quota]);

  useEffect(() => {
    let online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
    const markOff = () => {
      const next = applyOnlineState(online, 'offline');
      online = next.online;
      setOffline(!next.online);
    };
    const markOn = () => {
      const next = applyOnlineState(online, 'online');
      online = next.online;
      setOffline(!next.online);
    };
    window.addEventListener('offline', markOff);
    window.addEventListener('online', markOn);
    return () => {
      window.removeEventListener('offline', markOff);
      window.removeEventListener('online', markOn);
    };
  }, []);

  useEffect(() => {
    setSuggestSeed(0);
  }, [suggestionKey]);

  useEffect(() => {
    if (clipSeen.current === suggestionKey) return;
    clipSeen.current = suggestionKey;
    sendGen.current += 1;
    if (paceRaf.current) cancelAnimationFrame(paceRaf.current);
    paceRaf.current = 0;
    targetRef.current = paintedRef.current;
    chatAbort.current?.abort();
    busyRef.current = false;
    setBusy(false);
    setMessages((current) => dropUnfinishedReply(current));
  }, [suggestionKey]);

  useEffect(() => {
    let cancelled = false;
    checkChatBackend().then((status) => {
      if (cancelled) return;
      setChatState(status);
      if (status.state === 'exhausted') {
        setQuota({ scope: 'own_daily_cap', resetAt: status.resetAt, retryAfterSeconds: null });
      } else if (status.state === 'cooling') {
        setQuota({ scope: 'visitor_rate', retryAfterSeconds: status.retryAfterSeconds, resetAt: null });
      }
    });
    return () => {
      cancelled = true;
      chatAbort.current?.abort();
    };
  }, []);

  const visibleSuggestions = useMemo(
    () => buildSalientSuggestions(knowledge, suggestionVideoIds, { seed: suggestSeed, count: 4 }),
    [knowledge, suggestionKey, suggestSeed],
  );
  useEffect(() => {
    if (!cooldownUntil) {
      setCooldownLeft(0);
      return undefined;
    }
    const tick = () => {
      const left = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
      setCooldownLeft(left);
      if (left <= 0) setCooldownUntil(0);
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [cooldownUntil]);

  const chatReady = Boolean(knowledge && chatState?.ready);
  const inputPaused = chatState?.ready === false;

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

  function stopPace() {
    if (paceRaf.current) cancelAnimationFrame(paceRaf.current);
    paceRaf.current = 0;
    targetRef.current = paintedRef.current;
  }

  function paintTail(gen, text) {
    setMessages((m) => {
      if (gen !== sendGen.current) return m;
      const copy = [...m];
      const last = copy[copy.length - 1];
      if (last?.role !== 'assistant') return m;
      copy[copy.length - 1] = { ...last, text, model: modelRef.current || last.model };
      return copy;
    });
  }

  function pump(gen) {
    if (paceRaf.current) return;
    const tick = () => {
      paceRaf.current = 0;
      if (gen !== sendGen.current) return;
      const target = targetRef.current;
      const painted = paintedRef.current;
      if (target.startsWith(painted) && target.length > painted.length) {
        paintedRef.current = painted + target[painted.length];
        paintTail(gen, paintedRef.current);
        paceRaf.current = requestAnimationFrame(tick);
        return;
      }
      if (!target.startsWith(painted)) {
        paintedRef.current = target;
        paintTail(gen, target);
      }
    };
    paceRaf.current = requestAnimationFrame(tick);
  }

  function drainPaint(gen) {
    return new Promise((resolve) => {
      const watch = () => {
        if (gen !== sendGen.current || paintedRef.current === targetRef.current) {
          resolve();
          return;
        }
        requestAnimationFrame(watch);
      };
      watch();
    });
  }

  function clearChat() {
    sendGen.current += 1;
    stopPace();
    chatAbort.current?.abort();
    busyRef.current = false;
    setBusy(false);
    setMessages([]);
    setRetryArmed(false);
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
      // Clipboard can be denied; the message stays on screen.
    }
  }

  function stop() {
    stopPace();
    chatAbort.current?.abort();
  }

  function retry() {
    const turn = retryTurn(messages);
    if (!turn || busyRef.current) return;
    setRetryArmed(false);
    send(turn.text, { prior: turn.prior });
  }

  function releaseSend(gen) {
    if (gen !== sendGen.current) return;
    busyRef.current = false;
    setBusy(false);
  }

  async function send(text, { prior, suggested } = {}) {
    const q = (text ?? input).trim();
    if (!canAsk(mode, reels, suggestionVideoIds, q).ready) return;
    if (!acceptSend(busyRef.current, q, Date.now(), lastSentAt.current, prior ?? messages)) return;
    lastSentAt.current = Date.now();
    setCooldownUntil(lastSentAt.current + CHAT_COOLDOWN_MS);
    busyRef.current = true;
    setBusy(true);
    setRetryArmed(false);
    setInput('');
    setShowOfflineHints(false);
    stickRef.current = true;
    setShowJump(false);
    if (!prior) idemKey.current = (globalThis.crypto?.randomUUID?.() || `send-${Date.now()}`);
    const priorMessages = prior ?? messages;
    const gen = sendGen.current + 1;
    sendGen.current = gen;
    if (paceRaf.current) cancelAnimationFrame(paceRaf.current);
    paceRaf.current = 0;
    paintedRef.current = '';
    targetRef.current = '';
    modelRef.current = '';
    chatAbort.current?.abort();
    const ctrl = new AbortController();
    chatAbort.current = ctrl;
    setMessages(() => [...priorMessages, { role: 'user', text: q }, { role: 'assistant', text: '' }]);
      let ready = chatReady;
      if (!ready) {
        const status = await checkChatBackend(ctrl.signal);
        if (gen !== sendGen.current || status.aborted) {
          releaseSend(gen);
          return;
        }
        setChatState(status);
        ready = Boolean(knowledge && status.ready);
      }
    if (!ready) {
      if (gen !== sendGen.current) return;
      setMessages((m) => {
        const copy = [...m];
        copy[copy.length - 1] = {
          role: 'assistant',
          text: CHAT_PAUSED,
        };
        return copy;
      });
      setShowOfflineHints(true);
      setSuggestSeed((n) => n + 1);
      releaseSend(gen);
      return;
    }
    try {
      let acc = '';
      for await (const event of streamChatReply({
        priorMessages,
        message: q,
        signal: ctrl.signal,
        suggested: suggested === true,
        focus: {
          ids: suggestionVideoIds,
          timeSec: viewMoment?.timeSec,
          modes: replyModes,
          view: mode,
        },
        idempotencyKey: idemKey.current,
      })) {
        if (gen !== sendGen.current) return;
        if (event.type === 'meta') {
          modelRef.current = event.model || '';
          if (paintedRef.current) paintTail(gen, paintedRef.current);
          continue;
        }
        acc += event.text || '';
        targetRef.current = sanitizeAssistantText(acc);
        pump(gen);
      }
      if (gen !== sendGen.current) return;
      targetRef.current = sanitizeAssistantText(acc);
      pump(gen);
      await drainPaint(gen);
    } catch (err) {
      if (gen !== sendGen.current) return;
      if (err?.name === 'AbortError' || err?.code === 'ABORTED') {
        setRetryArmed(true);
        setMessages((m) => {
          const copy = [...m];
          const last = copy[copy.length - 1];
          if (last?.role !== 'assistant') return copy;
          if (!last.text) copy.pop();
          return copy;
        });
        return;
      }
      if (err?.code === 'CUT') {
        setRetryArmed(true);
        setMessages((m) => {
          const copy = [...m];
          const last = copy[copy.length - 1];
          if (last?.role === 'assistant') copy[copy.length - 1] = { ...last, incomplete: true };
          return copy;
        });
        return;
      }
      if (chatPaused(err)) console.error('[ask classy] paused');
      else console.error('[ask classy]', err?.name || 'Error');
      if (isCooling(err?.scope) || err?.scope === 'day_quota' || err?.scope === 'own_daily_cap') {
        setInput(q);
        setQuota({
          scope: err.scope,
          retryAfterSeconds: err.retryAfterSeconds,
          resetAt: err.resetAt,
        });
        setRetryArmed(false);
        setMessages((m) => {
          const copy = [...m];
          const last = copy[copy.length - 1];
          if (last?.role === 'assistant' && !last.text) copy.pop();
          return copy;
        });
        return;
      }
      const text = formatChatError(err);
      setRetryArmed(true);
      setMessages((m) => {
        const copy = [...m];
        copy[copy.length - 1] = {
          role: 'assistant',
          text,
          error: true,
        };
        return copy;
      });
    } finally {
      if (gen === sendGen.current) setSuggestSeed((n) => n + 1);
      releaseSend(gen);
    }
  }

  function onKeyDown(e) {
    if (mobile) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(e.currentTarget.value);
    }
  }

  if (collapsed && !mobile) {
    return (
      <div className="chat-rail">
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
          className="chat-rail-ask-btn"
          onClick={onToggleCollapse}
          title="Ask classy"
          aria-label="Ask classy"
        >
          <span className="ask-glyph" aria-hidden>?</span>
        </button>
      </div>
    );
  }

  const empty = messages.length === 0;
  const regionCanned = Boolean(chatState?.notice);
  const lastTurn = messages[messages.length - 1];
  const lastCannedOnly =
    lastTurn?.role === 'assistant' && lastTurn.text === CANNED_ONLY_REPLY;
  const showSuggestAfterTurn = regionCanned || lastCannedOnly || showOfflineHints;
  const suggestList = (keyPrefix, labelled) => (
    <div className="chat-suggest-list">
      {labelled && (
        <div className="section-label chat-suggest-label">try one of these</div>
      )}
      {visibleSuggestions.map((s, i) => (
        <button
          key={`${keyPrefix}${i}`}
          type="button"
          onClick={() => send(s, { suggested: true })}
          disabled={inputPaused || busy || Boolean(quota) || cooldownLeft > 0 || !canAsk(mode, reels, suggestionVideoIds, s).ready}
          className="text-left text-[13px] px-3 py-2.5 suggest-chip leading-snug"
        >
          {s}
        </button>
      ))}
    </div>
  );

  return (
    <div className="flex flex-col h-full min-h-0 relative">
      <div
        className="chat-header px-4 py-3 border-b hairline flex flex-col gap-3"
        style={{ background: 'var(--bg-subtle)' }}
      >
        <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="chat-title tracking-[0.04em]">ask classy</div>
          <div className="chat-subtitle text-[11px] tracking-[0.05em] mt-1">
            {chatState?.ready ? replyModeSummary(replyModes) : CHAT_PAUSED}
          </div>
          {chatState?.notice ? <p className="chat-region-note">{chatState.notice}</p> : null}
        </div>
        <div className="chat-header-actions shrink-0">
          {messages.length > 0 && (
            <button
              type="button"
              className="chat-text-btn"
              onClick={clearChat}
              title="Start a new chat. Closing this panel keeps this one."
              aria-label="New chat"
            >
              New chat
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
          </div>
        </div>
        </div>
      </div>

      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollRef}
          className={`chat-thread scroll-pane scroll-pane-y${empty ? ' chat-thread-empty' : ''}`}
          onScroll={onScroll}
        >
          {empty && suggestList('', true)}
          {messages.map((msg, i) => {
            const isModel = msg.role === 'assistant';
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
                    <span className="chat-thinking" aria-live="polite" aria-label="thinking">
                      <span className="chat-thinking-pulse" aria-hidden />
                      thinking
                    </span>
                  ) : (
                    <>
                      {body}
                      {isStreamingTail && msg.text ? <span className="chat-caret" aria-hidden /> : null}
                    </>
                  )}
                  {msg.incomplete && (
                    <div className="chat-cut">{CUT_LABEL}</div>
                  )}
                  {isModel && visitorModel(msg.model) && !msg.error && (msg.text || isStreamingTail) && (
                    <div className="chat-model-tag" title={`Model ${visitorModel(msg.model)}`}>
                      {visitorModel(msg.model)}
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
          {showSuggestAfterTurn && !empty && suggestList('hint-', !showOfflineHints)}
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
        {offline && (
          <div className="chat-offline" {...LIVE_REGION}>{OFFLINE_LABEL}</div>
        )}
        <div className="composer-shell">
          <ReplyModeGroup value={replyModes} onChange={toggleMode} disabled={busy || inputPaused || Boolean(quota)} />
          <p className="composer-lens-note sr-only" role="status" aria-live="polite">{lensNote}</p>
          <div className="composer-entry">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(capMessage(e.target.value))}
              onKeyDown={onKeyDown}
              rows={1}
              enterKeyHint={mobile ? 'enter' : 'send'}
              disabled={inputPaused}
              placeholder={inputPaused ? CHAT_PAUSED : replyModePlaceholder(replyModes)}
              className="w-full text-[13px] chat-input"
              aria-label={
                mobile
                  ? 'Message ask classy. Return for a new line, Send to submit.'
                  : 'Message ask classy. Enter to send, Shift+Enter for newline'
              }
            />
            {retryArmed && !busy && (
              <button
                type="button"
                onClick={retry}
                className="chat-send-btn text-[13px]"
                aria-label="Retry"
              >
                Retry
              </button>
            )}
            <button
              type="button"
              onClick={busy ? stop : () => send()}
              disabled={inputPaused || Boolean(quota) || (!busy && (!canAsk(mode, reels, suggestionVideoIds, input).ready || !acceptSend(false, input, Date.now(), cooldownUntil ? cooldownUntil - CHAT_COOLDOWN_MS : 0, messages)))}
              className="chat-send-btn btn-primary text-[13px]"
              aria-label={busy ? 'Stop reply' : 'Send'}
              title={busy ? 'Stop' : 'Send message'}
            >
              {busy ? 'Stop' : 'Send'}
            </button>
          </div>
          <div className="chat-quota" {...LIVE_REGION}>
            {composerHold({
              text: input,
              cooldownLeft,
              quotaText: quotaAnnouncement(quota, quotaLeft),
              history: messages,
            })}
          </div>
        </div>
        {chatState?.privacy && (
          <p className="chat-privacy-note">{CHAT_PRIVACY}</p>
        )}
      </div>
    </div>
  );
}
