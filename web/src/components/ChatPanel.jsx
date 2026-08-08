import { useCallback, useEffect, useRef, useState } from 'react';
import {
  aiConfigured,
  createChat,
  formatChatError,
  isQuotaError,
  localKnowledgeReply,
  sanitizeAssistantText,
  streamReply,
} from '../lib/ai';

const SUGGESTIONS = [
  "Why did B_V1 go viral when the others didn't?",
  'How is amplification computed for B_V1? Show the numbers.',
  'Which brain networks separate the breakouts from the tail?',
  'What does the hook slope measure, and who has the strongest hook?',
  'From a UGC/content view, what should the next reel copy?',
  'What are the biggest caveats of this analysis at N=10?',
];

const OFFLINE_REPLY =
  "classy isn't listening yet. try one of these instead:";

const NEAR_BOTTOM_PX = 64;
const TEXTAREA_MAX_LINES = 6;

function displayAssistantText(text) {
  return sanitizeAssistantText(text || '') || '…';
}

export default function ChatPanel({
  knowledge,
  collapsed = false,
  focused = false,
  mobile = false,
  onToggleCollapse,
  onToggleFocus,
  onCloseMobile,
}) {
  const [chat, setChat] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [showOfflineHints, setShowOfflineHints] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState(null);
  const scrollRef = useRef(null);
  const textareaRef = useRef(null);
  const stickRef = useRef(true);

  useEffect(() => {
    if (knowledge && aiConfigured) setChat(createChat(knowledge));
  }, [knowledge]);

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
    stickRef.current = true;
    if (knowledge && aiConfigured) setChat(createChat(knowledge));
    else setChat(null);
  }

  async function copyMessage(text, idx) {
    try {
      await navigator.clipboard.writeText(sanitizeAssistantText(text) || text);
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
    setMessages((m) => [...m, { role: 'user', text: q }, { role: 'model', text: '' }]);
    if (!chat) {
      setMessages((m) => {
        const copy = [...m];
        copy[copy.length - 1] = {
          role: 'model',
          text: OFFLINE_REPLY,
        };
        return copy;
      });
      setShowOfflineHints(true);
      return;
    }
    setBusy(true);
    try {
      let acc = '';
      for await (const chunk of streamReply(chat, q)) {
        acc += chunk;
        const cleaned = sanitizeAssistantText(acc);
        setMessages((m) => {
          const copy = [...m];
          copy[copy.length - 1] = { role: 'model', text: cleaned };
          return copy;
        });
      }
      const finalText = sanitizeAssistantText(acc);
      setMessages((m) => {
        const copy = [...m];
        copy[copy.length - 1] = {
          role: 'model',
          text: finalText,
        };
        return copy;
      });
    } catch (err) {
      console.error('[ask classy]', err);
      const apiMsg = formatChatError(err);
      let text = apiMsg;
      if (knowledge) {
        const local = localKnowledgeReply(knowledge, q);
        text = isQuotaError(err)
          ? `${apiMsg}\n\n${local}`
          : `${apiMsg}\n\nfallback from local data:\n${local}`;
      }
      setMessages((m) => {
        const copy = [...m];
        copy[copy.length - 1] = {
          role: 'model',
          text,
        };
        return copy;
      });
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e) {
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
          <div className="font-semibold tracking-[0.04em]" style={{ color: 'var(--text-primary)' }}>
            ask classy
          </div>
          <div className="text-[11px] tracking-[0.05em] mt-1" style={{ color: 'var(--text-secondary)' }}>
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
                className="section-label mb-1"
                style={{ color: 'var(--text-secondary)' }}
              >
                try one of these
              </div>
              {SUGGESTIONS.map((s) => (
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
            const body = isModel ? displayAssistantText(msg.text) : msg.text || '…';
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
              {SUGGESTIONS.map((s) => (
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

      <div className="p-3 border-t hairline flex gap-2 items-end" style={{ background: 'var(--bg-subtle)' }}>
        <div className="flex-1 min-w-0">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder="ask me something… ↵ send · ⇧↵ newline"
            className="w-full input-field px-3 py-2 text-[13px] chat-input"
            aria-label="Message ask classy. Enter to send, Shift+Enter for newline"
          />
        </div>
        <button
          type="button"
          onClick={() => send()}
          disabled={busy || !input.trim()}
          className="px-4 py-2 btn-primary text-[13px] shrink-0"
          title="Send message"
        >
          Send
        </button>
      </div>
    </div>
  );
}
