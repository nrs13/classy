import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadManifest, loadBrain } from './lib/data';
import ReelStage from './components/ReelStage';
import ChatPanel from './components/ChatPanel';
import CompareVerdict from './components/CompareVerdict';
import { suggestionFocusIds } from './lib/suggestedQuestions';

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
const COMPARE_VIEWS = ['front', 'left', 'right', 'back'];
const CHAT_H_KEY = 'classy-chat-h';
const CHAT_COLLAPSED_KEY = 'classy-chat-collapsed';
const CHAT_H_DEFAULT = 300;
const CHAT_H_MIN = 220;
const CHAT_RAIL_H = 44;
const RESIZE_STEP = 16;

function fmtPlays(n) {
  if (n == null) return '-';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return String(n);
}

function readStoredHeight() {
  try {
    const raw = localStorage.getItem(CHAT_H_KEY);
    const n = Number(raw);
    if (Number.isFinite(n) && n >= CHAT_H_MIN) return n;
  } catch {
    /* ignore */
  }
  return CHAT_H_DEFAULT;
}

function readStoredCollapsed() {
  try {
    return localStorage.getItem(CHAT_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function clampChatH(px) {
  const MAIN_MIN = 320;
  const avail = window.innerHeight - MAIN_MIN;
  const max = Math.max(
    200,
    Math.min(Math.floor(window.innerHeight * 0.6), Math.floor(avail)),
  );
  return Math.max(Math.min(CHAT_H_MIN, max), Math.min(max, Math.round(px)));
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
  const [compareView, setCompareView] = useState(null);
  const compareViewNonce = useRef(0);
  const [focusIdx, setFocusIdx] = useState(0);
  const listRef = useRef(null);
  const itemRefs = useRef([]);
  const [listOverflow, setListOverflow] = useState(false);

  const [chatH, setChatH] = useState(readStoredHeight);
  const [chatCollapsed, setChatCollapsed] = useState(readStoredCollapsed);
  const [chatFocused, setChatFocused] = useState(false);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [reelDrawerOpen, setReelDrawerOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 768px)').matches : false,
  );
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef(null);
  const [viewMoment, setViewMoment] = useState({ videoId: null, timeSec: 0 });
  const viewMomentTimer = useRef(null);

  const onViewMoment = useCallback((moment) => {
    if (!moment?.videoId) return;
    if (viewMomentTimer.current) clearTimeout(viewMomentTimer.current);
    viewMomentTimer.current = setTimeout(() => {
      setViewMoment({
        videoId: moment.videoId,
        timeSec: Number(moment.timeSec) || 0,
      });
    }, 180);
  }, []);

  useEffect(() => {
    const manifestRequest = loadManifest();
    manifestRequest.then((m) => {
      setManifest(m);
      const first = m.videos[0]?.id;
      setSelId(first);
      setCompareIds(first ? [first] : []);
    });
    manifestRequest.then(loadBrain).then(setBrain);
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
      note: 'Derived from manifest; run web_export.py for the full pack.',
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
      localStorage.setItem(CHAT_H_KEY, String(chatH));
    } catch {
      /* ignore */
    }
  }, [chatH]);

  useEffect(() => {
    try {
      localStorage.setItem(CHAT_COLLAPSED_KEY, chatCollapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [chatCollapsed]);

  useEffect(() => {
    function onResize() {
      setChatH((h) => clampChatH(h));
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const setChatHeightLive = useCallback((px) => {
    setChatH(clampChatH(px));
  }, []);

  const beginResize = useCallback(
    (clientY) => {
      if (isMobile || chatCollapsed || chatFocused) return;
      dragRef.current = { startY: clientY, startH: chatH };
      setResizing(true);
    },
    [isMobile, chatCollapsed, chatFocused, chatH],
  );

  useEffect(() => {
    if (!resizing) return;
    function onMove(e) {
      const d = dragRef.current;
      if (!d) return;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const next = d.startH + (d.startY - clientY);
      setChatHeightLive(next);
    }
    function onUp() {
      setResizing(false);
      dragRef.current = null;
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onUp);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [resizing, setChatHeightLive]);

  const onResizeKeyDown = useCallback(
    (e) => {
      if (chatCollapsed || chatFocused || isMobile) return;
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setChatHeightLive(chatH + RESIZE_STEP);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setChatHeightLive(chatH - RESIZE_STEP);
      } else if (e.key === 'Home') {
        e.preventDefault();
        setChatHeightLive(CHAT_H_MIN);
      } else if (e.key === 'End') {
        e.preventDefault();
        setChatHeightLive(window.innerHeight * 0.6);
      }
    },
    [chatCollapsed, chatFocused, isMobile, chatH, setChatHeightLive],
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
  const networksById = useMemo(() => {
    const map = {};
    (knowledge?.videos || []).forEach((video) => {
      if (video?.id && video.networks) map[video.id] = video.networks;
    });
    return map;
  }, [knowledge]);

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
        if (reelDrawerOpen) {
          e.preventDefault();
          setReelDrawerOpen(false);
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
  }, [videos, focusIdx, mode, onReelActivate, chatFocused, mobileChatOpen, reelDrawerOpen]);

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
          <div className="brand-mark text-2xl tracking-[0.08em]">classy</div>
          <div className="type-caption text-[11px] tracking-[0.06em] mt-2" style={{ color: 'var(--text-tertiary)' }}>
            loading…
          </div>
        </div>
      </div>
    );
  }

  const sel = byId[selId];
  const compareVideos = compareIds.map((id) => byId[id]).filter(Boolean);

  const chatDockStyle = isMobile
    ? undefined
    : {
        height: chatFocused
          ? 'min(72vh, calc(100vh - 200px))'
          : chatCollapsed
            ? `${CHAT_RAIL_H}px`
            : `${chatH}px`,
      };

  // Explore uses the selected reel; Compare merges salience across the selection.
  const suggestionVideoIds = suggestionFocusIds({
    mode,
    selId,
    compareIds,
    viewMoment,
  });

  const chatPanelProps = {
    knowledge,
    viewMoment,
    suggestionVideoIds,
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
          <div className="brand-mark text-[28px] leading-none">classy</div>
          <div className="brand-tagline text-[12px] mt-1.5">marketing reimagined</div>
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
        className={`layout-grid ${isMobile ? 'layout-grid-mobile' : ''} ${chatFocused ? 'layout-grid-focus' : ''}`}
      >
        {!isMobile && (
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
                        {v.annotations?.format && (
                          <div className="reel-item-desc">{v.annotations.format}</div>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
            {listOverflow && <div className="reel-scroll-fade" aria-hidden />}
          </div>
        </aside>
        )}

        <main className="overflow-y-auto overflow-x-hidden p-4 min-w-0" style={{ background: 'var(--bg)' }}>
          {isMobile && (
            <div className="mobile-reel-bar">
              <button
                type="button"
                className="mobile-reel-bar-btn"
                onClick={() => setReelDrawerOpen(true)}
                aria-expanded={reelDrawerOpen}
                aria-haspopup="dialog"
              >
                <span className="mobile-reel-bar-id">
                  {mode === 'compare'
                    ? `${compareIds.length}/${COMPARE_CAP} selected`
                    : selId || 'reels'}
                </span>
                <span className="mobile-reel-bar-meta">
                  {mode === 'compare' ? (
                    'select reels'
                  ) : sel ? (
                    <>
                      <span className="reel-item-meta-plays">
                        {fmtPlays(sel.metrics?.plays)} plays ·{' '}
                      </span>
                      <span className={`tier-label ${tierClass(sel.tier)}`}>[{sel.tier}]</span>
                    </>
                  ) : (
                    'select a reel'
                  )}
                </span>
              </button>
            </div>
          )}
          {mode === 'explore' ? (
            sel && (
              <ReelStage
                key={sel.id}
                video={sel}
                brain={brain}
                networks={networksById[sel.id]}
                onViewMoment={onViewMoment}
              />
            )
          ) : (
            <div className="flex flex-col gap-3">
              {compareVideos.length >= 2 && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <label className="sync-toggle self-start">
                    <input
                      type="checkbox"
                      checked={syncPlayback}
                      onChange={(e) => setSyncPlayback(e.target.checked)}
                    />
                    <span className="sync-toggle-box" aria-hidden />
                    <span>sync playback</span>
                  </label>
                  <div
                    className="compare-view-group"
                    role="group"
                    aria-label="Lock every brain to the same angle"
                  >
                    <span className="compare-view-label">lock angle</span>
                    {COMPARE_VIEWS.map((name) => (
                      <button
                        key={name}
                        type="button"
                        className={`brain-view-btn${
                          compareView?.preset === name ? ' is-active' : ''
                        }`}
                        aria-pressed={compareView?.preset === name}
                        title={`Point every brain ${name}`}
                        onClick={() => {
                          compareViewNonce.current += 1;
                          setCompareView({ preset: name, nonce: compareViewNonce.current });
                        }}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                  {isMobile && (
                    <span
                      className="text-[11px] tracking-[0.03em]"
                      style={{ color: 'var(--text-tertiary)' }}
                    >
                      swipe for next reel
                    </span>
                  )}
                </div>
              )}

              {compareVideos.length === 0 ? (
                <div
                  className="text-[13px] tracking-[0.03em] py-12 text-center"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  select up to {COMPARE_CAP} reels from the list
                </div>
              ) : (
                <>
                {compareVideos.length >= 2 && <CompareVerdict videos={compareVideos} />}
                <div className={`compare-grid${isMobile ? ' compare-grid-mobile' : ''}`}>
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
                      <div className="type-heading text-[13px] tracking-[0.01em] pr-6">
                        {v.id}
                      </div>
                      <div className="compare-card-desc">
                        {[v.account, v.annotations?.format].filter(Boolean).join(' · ') ||
                          ' '}
                      </div>
                      <ReelStage
                        key={'c-' + v.id}
                        video={v}
                        brain={brain}
                        networks={networksById[v.id]}
                        layout="stack"
                        syncPlayback={syncPlayback}
                        syncedPlaying={syncedPlaying}
                        onSyncPlayChange={setSyncedPlaying}
                        onViewMoment={onViewMoment}
                        externalView={compareView}
                      />
                    </div>
                  ))}
                </div>
                </>
              )}
            </div>
          )}
        </main>

        </div>

      {!isMobile && (
        <section
          className={`chat-dock border-t hairline min-h-0 relative ${resizing ? 'is-resizing' : ''}`}
          style={chatDockStyle}
        >
          {!chatCollapsed && !chatFocused && (
            <div
              className="chat-resize-handle"
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize ask classy panel"
              aria-valuemin={CHAT_H_MIN}
              aria-valuemax={Math.floor(typeof window !== 'undefined' ? window.innerHeight * 0.6 : 500)}
              aria-valuenow={chatH}
              tabIndex={0}
              onPointerDown={(e) => {
                e.preventDefault();
                beginResize(e.clientY);
              }}
              onKeyDown={onResizeKeyDown}
              title="Drag to resize"
            />
          )}
          <ChatPanel {...chatPanelProps} mobile={false} />
        </section>
      )}

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
                viewMoment={viewMoment}
                suggestionVideoIds={suggestionVideoIds}
                mobile
                onCloseMobile={() => setMobileChatOpen(false)}
              />
            </div>
          )}
          {reelDrawerOpen && (
            <div
              className="reel-drawer-root"
              role="dialog"
              aria-modal="true"
              aria-label="Choose reels"
            >
              <button
                type="button"
                className="reel-drawer-backdrop"
                aria-label="Close reel list"
                onClick={() => setReelDrawerOpen(false)}
              />
              <div className="reel-drawer-sheet">
                <div className="reel-drawer-header">
                  <div className="section-label">reels</div>
                  <div className="reel-drawer-header-meta">
                    <span>
                      {mode === 'compare'
                        ? `${compareIds.length}/${COMPARE_CAP} selected`
                        : 'select a reel'}
                    </span>
                    <button
                      type="button"
                      className="reel-drawer-done"
                      onClick={() => setReelDrawerOpen(false)}
                    >
                      done
                    </button>
                  </div>
                </div>
                {compareCapMsg && mode === 'compare' && (
                  <div className="mx-4 mb-2 text-[11px] tracking-[0.03em] leading-snug compare-cap-msg">
                    remove one to add another
                  </div>
                )}
                <div className="reel-drawer-list">
                  {videos.map((v, i) => {
                    const selected =
                      mode === 'compare' ? compareIds.includes(v.id) : selId === v.id;
                    const tierCls = tierClass(v.tier);
                    return (
                      <button
                        key={v.id}
                        type="button"
                        onClick={() => {
                          setFocusIdx(i);
                          onReelActivate(v.id);
                          if (mode === 'explore') setReelDrawerOpen(false);
                        }}
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
                            {v.annotations?.format && (
                              <div className="reel-item-desc">{v.annotations.format}</div>
                            )}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
