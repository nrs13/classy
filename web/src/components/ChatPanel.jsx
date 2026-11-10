import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  checkChatBackend,
  formatChatError,
  sanitizeAssistantText,
  streamChatReply,
} from '../lib/ai';
import { buildSalientSuggestions } from '../lib/suggestedQuestions';
import {
  DEFAULT_REPLY_MODES,
  replyModePlaceholder,
  replyModeSummary,
  toggleReplyMode,
} from '../lib/replyModes';
import ReplyModeGroup from './ReplyModeGroup';

const OFFLINE_REPLY =
  "classy isn't listening yet. try one of these instead:";

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
}) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [showOfflineHints, setShowOfflineHints] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState(null);
  const [suggestSeed, setSuggestSeed] = useState(0);
  const [backendReady, setBackendReady] = useState(null);
  const [replyModes, setReplyModes] = useState(DEFAULT_REPLY_MODES);
  const scrollRef = useRef(null);
  const textareaRef = useRef(null);
  const stickRef = useRef(true);
  const chatAbort = useRef(null);
  const sendGen = useRef(0);
  const suggestionKey = suggestionVideoIds.join('|');

  const toggleMode = useCallback((id) => {
    setReplyModes((current) => toggleReplyMode(current, id));
  }, []);

  useEffect(() => {
    setSuggestSeed(0);
  }, [suggestionKey]);

  useEffect(() => {
    let cancelled = false;
    checkChatBackend().then((status) => {
      if (!cancelled) setBackendReady(status === 'ready');
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
  const chatReady = Boolean(knowledge && backendReady);

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
      // Clipboard can be denied; the message stays on screen.
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
    const gen = sendGen.current + 1;
    sendGen.current = gen;
    chatAbort.current?.abort();
    const ctrl = new AbortController();
    chatAbort.current = ctrl;
    setMessages((m) => [...m, { role: 'user', text: q }, { role: 'assistant', text: '' }]);
    let ready = chatReady;
    if (!ready) {
      const status = await checkChatBackend(ctrl.signal);
      if (gen !== sendGen.current || status === 'aborted') return;
      const up = status === 'ready';
      setBackendReady(up);
      ready = Boolean(knowledge && up);
    }
    if (!ready) {
      if (gen !== sendGen.current) return;
      setMessages((m) => {
        const copy = [...m];
        copy[copy.length - 1] = {
          role: 'assistant',
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
        priorMessages,
        message: q,
        signal: ctrl.signal,
        focus: {
          ids: suggestionVideoIds,
          timeSec: viewMoment?.timeSec,
          modes: replyModes,
        },
      })) {
        if (gen !== sendGen.current) return;
        if (event.type === 'meta') {
          usedModel = event.model;
          setMessages((m) => {
            const copy = [...m];
            copy[copy.length - 1] = {
              role: 'assistant',
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
            role: 'assistant',
            text: cleaned,
            model: usedModel,
          };
          return copy;
        });
      }
      if (gen !== sendGen.current) return;
      const finalText = sanitizeAssistantText(acc);
      setMessages((m) => {
        const copy = [...m];
        copy[copy.length - 1] = {
          role: 'assistant',
          text: finalText,
          model: usedModel,
        };
        return copy;
      });
    } catch (err) {
      if (err?.name === 'AbortError' || err?.code === 'ABORTED' || gen !== sendGen.current) return;
      console.error('[ask classy]', err);
      const text = formatChatError(err);
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
      if (gen === sendGen.current) {
        setBusy(false);
        setSuggestSeed((n) => n + 1);
      }
    }
  }

  function onKeyDown(e) {
    if (mobile) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
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
  const suggestList = (keyPrefix, labelled) => (
    <div className="chat-suggest-list">
      {labelled && (
        <div className="section-label chat-suggest-label">try one of these</div>
      )}
      {visibleSuggestions.map((s, i) => (
        <button
          key={`${keyPrefix}${i}`}
          type="button"
          onClick={() => send(s)}
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
        className="chat-header px-4 py-3 border-b hairline flex items-start justify-between gap-3"
        style={{ background: 'var(--bg-subtle)' }}
      >
        <div className="min-w-0">
          <div className="chat-title tracking-[0.04em]">ask classy</div>
          <div className="chat-subtitle text-[11px] tracking-[0.05em] mt-1">
            {backendReady ? replyModeSummary(replyModes) : "classy isn't listening yet"}
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
          {showOfflineHints && suggestList('hint-', false)}
          {!empty && !busy && !showOfflineHints && suggestList(`next-${suggestSeed}-`, true)}
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
        <div className="composer-shell">
          <ReplyModeGroup value={replyModes} onChange={toggleMode} disabled={busy} />
          <div className="composer-entry">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              enterKeyHint={mobile ? 'enter' : 'send'}
              placeholder={replyModePlaceholder(replyModes)}
              className="w-full text-[13px] chat-input"
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
      </div>
    </div>
  );
}
