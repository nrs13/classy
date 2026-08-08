import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadManifest, loadBrain } from './lib/data';
import ReelStage from './components/ReelStage';
import ChatPanel from './components/ChatPanel';

const TIER_CLASS = {
  breakout: 'tier-breakout',
  strong: 'tier-strong',
  mid: 'tier-mid',
  tail: 'tier-tail',
};

function tierClass(tier) {
  if (!tier) return 'tier-tail';
  return TIER_CLASS[String(tier).toLowerCase()] || 'tier-tail';
}

const COMPARE_CAP = 4;
const CHAT_W_KEY = 'classy-chat-w';
const CHAT_COLLAPSED_KEY = 'classy-chat-collapsed';
const CHAT_W_DEFAULT = 340;
const CHAT_W_MIN = 320;
const CHAT_RAIL_W = 44;
const RESIZE_STEP = 16;

function fmtPlays(n) {
  if (n == null) return '-';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return String(n);
}

function readStoredWidth() {
  try {
    const raw = localStorage.getItem(CHAT_W_KEY);
    const n = Number(raw);
    if (Number.isFinite(n) && n >= CHAT_W_MIN) return n;
  } catch {
    /* ignore */
  }
  return CHAT_W_DEFAULT;
}

function readStoredCollapsed() {
  try {
    return localStorage.getItem(CHAT_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function clampChatW(px) {
  const max = Math.floor(window.innerWidth * 0.5);
  return Math.max(CHAT_W_MIN, Math.min(max, Math.round(px)));
}

export default function App() {
  const [manifest, setManifest] = useState(null);
  const [brain, setBrain] = useState(null);
  const [knowledge, setKnowledge] = useState(null);
  const [mode, setMode] = useState('explore');
  const [selId, setSelId] = useState(null);
  const [compareIds, setCompareIds] = useState([]);
  const [compareCapMsg, setCompareCapMsg] = useState(false);
  const [syncPlayback, setSyncPlayback] = useState(false);
  const [syncedPlaying, setSyncedPlaying] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const listRef = useRef(null);
  const itemRefs = useRef([]);
  const [listOverflow, setListOverflow] = useState(false);

  const [chatW, setChatW] = useState(readStoredWidth);
  const [chatCollapsed, setChatCollapsed] = useState(readStoredCollapsed);
  const [chatFocused, setChatFocused] = useState(false);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 768px)').matches : false,
  );
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef(null);

  useEffect(() => {
    loadManifest().then((m) => {
      setManifest(m);
      const first = m.videos[0]?.id;
      setSelId(first);
      setCompareIds(first ? [first] : []);
    });
    loadBrain().then(setBrain);
    fetch('/data/knowledge.json')
      .then((r) => {
        const ct = r.headers.get('content-type') || '';
        if (!r.ok || ct.includes('text/html')) return null;
        return r.json();
      })
      .then(setKnowledge)
      .catch(() => setKnowledge(null));
  }, []);

  useEffect(() => {
    if (knowledge || !manifest) return;
    setKnowledge({
      product: 'Classy',
      note: 'Placeholder knowledge derived from manifest; run web_export.py for the full pack.',
      videos: manifest.videos,
      formulas: {
        like_rate: 'likes / plays',
        amplification: 'plays / followers',
      },
    });
  }, [manifest, knowledge]);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const onChange = () => {
      const mobile = mq.matches;
      setIsMobile(mobile);
      if (mobile) {
        setChatFocused(false);
        setResizing(false);
      } else {
        setMobileChatOpen(false);
      }
    };
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(CHAT_W_KEY, String(chatW));
    } catch {
      /* ignore */
    }
  }, [chatW]);

  useEffect(() => {
    try {
      localStorage.setItem(CHAT_COLLAPSED_KEY, chatCollapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [chatCollapsed]);

  useEffect(() => {
    function onResize() {
      setChatW((w) => clampChatW(w));
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const setChatWidthLive = useCallback((px) => {
    setChatW(clampChatW(px));
  }, []);

  const beginResize = useCallback(
    (clientX) => {
      if (isMobile || chatCollapsed || chatFocused) return;
      dragRef.current = { startX: clientX, startW: chatW };
      setResizing(true);
    },
    [isMobile, chatCollapsed, chatFocused, chatW],
  );

  useEffect(() => {
    if (!resizing) return;
    function onMove(e) {
      const d = dragRef.current;
      if (!d) return;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      // Dragging left edge: moving left grows the panel
      const next = d.startW + (d.startX - clientX);
      setChatWidthLive(next);
    }
    function onUp() {
      setResizing(false);
      dragRef.current = null;
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [resizing, setChatWidthLive]);

  const onResizeKeyDown = useCallback(
    (e) => {
      if (chatCollapsed || chatFocused || isMobile) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setChatWidthLive(chatW + RESIZE_STEP);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setChatWidthLive(chatW - RESIZE_STEP);
      } else if (e.key === 'Home') {
        e.preventDefault();
        setChatWidthLive(CHAT_W_MIN);
      } else if (e.key === 'End') {
        e.preventDefault();
        setChatWidthLive(window.innerWidth * 0.5);
      }
    },
    [chatCollapsed, chatFocused, isMobile, chatW, setChatWidthLive],
  );

  const toggleCollapse = useCallback(() => {
    setChatFocused(false);
    setChatCollapsed((c) => !c);
  }, []);

  const toggleFocus = useCallback(() => {
    setChatCollapsed(false);
    setChatFocused((f) => !f);
  }, []);

  const byId = useMemo(() => {
    const map = {};
    (manifest?.videos || []).forEach((v) => (map[v.id] = v));
    return map;
  }, [manifest]);

  const videos = manifest?.videos || [];

  const checkOverflow = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    setListOverflow(el.scrollHeight > el.clientHeight + 4);
  }, []);

  useEffect(() => {
    checkOverflow();
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(checkOverflow);
    ro.observe(el);
    return () => ro.disconnect();
  }, [videos.length, checkOverflow]);

  useEffect(() => {
    const el = itemRefs.current[focusIdx];
    if (!el) return;
    el.scrollIntoView({ block: 'nearest' });
    if (document.activeElement !== el) el.focus({ preventScroll: true });
  }, [focusIdx]);

  const toggleCompare = useCallback((id) => {
    setCompareIds((prev) => {
      if (prev.includes(id)) {
        setCompareCapMsg(false);
        return prev.filter((x) => x !== id);
      }
      if (prev.length >= COMPARE_CAP) {
        setCompareCapMsg(true);
        return prev;
      }
      setCompareCapMsg(false);
      return [...prev, id];
    });
  }, []);

  const removeCompare = useCallback((id) => {
    setCompareIds((prev) => prev.filter((x) => x !== id));
    setCompareCapMsg(false);
  }, []);

  const onReelActivate = useCallback(
    (id) => {
      if (mode === 'compare') toggleCompare(id);
      else setSelId(id);
    },
    [mode, toggleCompare],
  );

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') {
        if (chatFocused) {
          e.preventDefault();
          setChatFocused(false);
          return;
        }
        if (mobileChatOpen) {
          e.preventDefault();
          setMobileChatOpen(false);
          return;
        }
      }
      if (!videos.length) return;
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusIdx((i) => Math.min(videos.length - 1, i + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusIdx((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const v = videos[focusIdx];
        if (v) onReelActivate(v.id);
      } else if (e.key === 'Escape' && mode === 'compare') {
        e.preventDefault();
        setCompareIds([]);
        setCompareCapMsg(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [videos, focusIdx, mode, onReelActivate, chatFocused, mobileChatOpen]);

  useEffect(() => {
    if (!syncPlayback) setSyncedPlaying(false);
  }, [syncPlayback]);

  useEffect(() => {
    if (compareIds.length < 2) {
      setSyncPlayback(false);
      setSyncedPlaying(false);
    }
  }, [compareIds.length]);

  if (!manifest || !brain) {
    return (
      <div className="h-full grid place-items-center app-shell" style={{ color: 'var(--text-tertiary)' }}>
        <div className="text-center">
          <div className="text-2xl font-bold tracking-[0.08em]" style={{ color: 'var(--text-primary)' }}>
            classy
          </div>
          <div className="text-[11px] tracking-[0.06em] mt-2">loading…</div>
        </div>
      </div>
    );
  }

  const sel = byId[selId];
  const compareVideos = compareIds.map((id) => byId[id]).filter(Boolean);

  const layoutStyle = isMobile
    ? undefined
    : {
        '--chat-w': chatFocused ? '76vw' : chatCollapsed ? `${CHAT_RAIL_W}px` : `${chatW}px`,
      };

  const chatPanelProps = {
    knowledge,
    collapsed: chatCollapsed && !chatFocused,
    focused: chatFocused,
    onToggleCollapse: toggleCollapse,
    onToggleFocus: toggleFocus,
  };

  return (
    <div className="h-full flex flex-col app-shell">
      <header
        className="flex items-center justify-between px-6 py-4 border-b hairline"
        style={{ background: 'var(--bg-subtle)' }}
      >
        <div>
          <div
            className="text-[26px] font-bold tracking-[0.08em] leading-none"
            style={{ color: 'var(--text-primary)' }}
          >
            classy
          </div>
          <div
            className="text-[11px] tracking-[0.06em] mt-1.5"
            style={{ color: 'var(--text-secondary)' }}
          >
            marketing reimagined
          </div>
        </div>
        <div className="flex gap-1 mode-toggle p-1 text-[12px]">
          {['explore', 'compare'].map((mo) => (
            <button
              key={mo}
              type="button"
              onClick={() => {
                setMode(mo);
                if (mo === 'compare' && compareIds.length === 0 && selId) {
                  setCompareIds([selId]);
                }
                setCompareCapMsg(false);
              }}
              className={`mode-tab px-3.5 py-1.5 capitalize ${mode === mo ? 'active' : ''}`}
            >
              {mo}
            </button>
          ))}
        </div>
      </header>

      <div
        className={`layout-grid ${isMobile ? 'layout-grid-mobile' : ''} ${chatFocused ? 'layout-grid-focus' : ''} ${chatCollapsed && !chatFocused ? 'layout-grid-collapsed' : ''}`}
        style={layoutStyle}
      >
        <aside className="border-r hairline flex flex-col min-h-0" style={{ background: 'var(--bg)' }}>
          <div className="px-4 pt-4 pb-2 flex items-baseline justify-between gap-2">
            <div className="section-label">reels</div>
            {mode === 'compare' && (
              <div className="text-[11px] tracking-[0.04em]" style={{ color: 'var(--text-secondary)' }}>
                {compareIds.length}/{COMPARE_CAP} selected
              </div>
            )}
          </div>

          {compareCapMsg && mode === 'compare' && (
            <div className="mx-4 mb-2 text-[11px] tracking-[0.03em] leading-snug compare-cap-msg">
              remove one to add another
            </div>
          )}

          <div className="reel-list-wrap flex-1 min-h-0 relative">
            <div
              ref={listRef}
              className="h-full overflow-y-auto px-4 pb-4 space-y-1"
              onScroll={checkOverflow}
            >
              {videos.map((v, i) => {
                const selected =
                  mode === 'compare' ? compareIds.includes(v.id) : selId === v.id;
                const tierCls = tierClass(v.tier);
                return (
                  <button
                    key={v.id}
                    ref={(el) => {
                      itemRefs.current[i] = el;
                    }}
                    type="button"
                    onClick={() => {
                      setFocusIdx(i);
                      onReelActivate(v.id);
                    }}
                    onFocus={() => setFocusIdx(i)}
                    className={`w-full text-left px-3 py-2.5 reel-item ${selected ? 'active' : ''}`}
                    aria-current={selected ? 'true' : undefined}
                  >
                    <div className="flex items-start gap-2">
                      {mode === 'compare' && (
                        <span
                          className={`reel-check ${selected ? 'checked' : ''}`}
                          aria-hidden
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="reel-item-id text-[13px] tracking-[0.03em]">{v.id}</div>
                        <div className="reel-item-meta text-[11px] tracking-[0.03em] mt-0.5">
                          <span className="reel-item-meta-plays">
                            {fmtPlays(v.metrics?.plays)} plays ·{' '}
                          </span>
                          <span className={`tier-label ${tierCls}`}>[{v.tier}]</span>
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
              <div
                className="pt-4 text-[11px] px-1 leading-relaxed tracking-[0.03em]"
                style={{ color: 'var(--text-tertiary)' }}
              >
                <span className="sync-pulse" aria-hidden />
                Colour = predicted activation (turbo). Explore one reel, or compare up to four.
              </div>
            </div>
            {listOverflow && <div className="reel-scroll-fade" aria-hidden />}
          </div>
        </aside>

        <main className="overflow-y-auto overflow-x-hidden p-4 min-w-0" style={{ background: 'var(--bg)' }}>
          {mode === 'explore' ? (
            sel && <ReelStage key={sel.id} video={sel} brain={brain} />
          ) : (
            <div className="flex flex-col gap-3">
              {compareVideos.length >= 2 && (
                <label className="sync-toggle self-start">
                  <input
                    type="checkbox"
                    checked={syncPlayback}
                    onChange={(e) => setSyncPlayback(e.target.checked)}
                  />
                  <span className="sync-toggle-box" aria-hidden />
                  <span>sync playback</span>
                </label>
              )}

              {compareVideos.length === 0 ? (
                <div
                  className="text-[13px] tracking-[0.03em] py-12 text-center"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  select up to {COMPARE_CAP} reels from the list
                </div>
              ) : (
                <div className="compare-grid">
                  {compareVideos.map((v) => (
                    <div key={v.id} className="compare-card">
                      <button
                        type="button"
                        className="compare-close"
                        onClick={() => removeCompare(v.id)}
                        title="Remove from comparison"
                        aria-label={`Remove ${v.id} from comparison`}
                      >
                        ×
                      </button>
                      <div
                        className="text-[13px] font-semibold mb-2 tracking-[0.04em] pr-6"
                        style={{ color: 'var(--text-primary)' }}
                      >
                        {v.id}
                      </div>
                      <ReelStage
                        key={'c-' + v.id}
                        video={v}
                        brain={brain}
                        layout="stack"
                        syncPlayback={syncPlayback}
                        syncedPlaying={syncedPlaying}
                        onSyncPlayChange={setSyncedPlaying}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </main>

        {!isMobile && (
          <aside
            className={`chat-column border-l hairline min-h-0 min-w-0 relative ${resizing ? 'is-resizing' : ''}`}
            style={{ background: 'var(--bg)' }}
          >
            {!chatCollapsed && !chatFocused && (
              <div
                className="chat-resize-handle"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize ask classy panel"
                aria-valuemin={CHAT_W_MIN}
                aria-valuemax={Math.floor(typeof window !== 'undefined' ? window.innerWidth * 0.5 : 800)}
                aria-valuenow={chatW}
                tabIndex={0}
                onPointerDown={(e) => {
                  e.preventDefault();
                  beginResize(e.clientX);
                }}
                onKeyDown={onResizeKeyDown}
                title="Drag to resize"
              />
            )}
            <ChatPanel {...chatPanelProps} mobile={false} />
          </aside>
        )}
      </div>

      {isMobile && (
        <>
          {!mobileChatOpen && (
            <button
              type="button"
              className="chat-fab"
              onClick={() => setMobileChatOpen(true)}
              title="Ask classy"
              aria-label="Open ask classy"
            >
              <span className="chat-fab-glyph" aria-hidden>
                ?
              </span>
              <span className="chat-fab-text">ask</span>
            </button>
          )}
          {mobileChatOpen && (
            <div className="chat-mobile-overlay" role="dialog" aria-modal="true" aria-label="Ask classy">
              <ChatPanel
                knowledge={knowledge}
                mobile
                onCloseMobile={() => setMobileChatOpen(false)}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
