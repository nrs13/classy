import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadManifest, loadBrain } from './lib/data';
import ReelStage from './components/ReelStage';
import ChatPanel from './components/ChatPanel';
import { CompareVerdictLayout } from './components/CompareVerdict';
import ReelId from './components/ReelId';
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
const COMPARE_CAP_MSG = 'remove one to add another';
const COMPARE_VIEWS = ['front', 'left', 'right', 'back'];
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
  const SIDEBAR_RESERVE = 200;
  const MAIN_MIN = 360;
  const avail = window.innerWidth - SIDEBAR_RESERVE - MAIN_MIN;
  const max = Math.max(
    240,
    Math.min(Math.floor(window.innerWidth * 0.5), Math.floor(avail)),
  );
  return Math.max(Math.min(CHAT_W_MIN, max), Math.min(max, Math.round(px)));
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
  const [compareCamera, setCompareCamera] = useState(null);
  const [focusIdx, setFocusIdx] = useState(0);
  const listRef = useRef(null);
  const itemRefs = useRef([]);
  const [listOverflow, setListOverflow] = useState(false);

  const [chatW, setChatW] = useState(readStoredWidth);
  const [chatCollapsed, setChatCollapsed] = useState(readStoredCollapsed);
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
    const timers = new WeakMap();
    function onScroll(e) {
      const el = e.target;
      if (!(el instanceof Element) || !el.classList.contains('scroll-pane')) return;
      el.classList.add('is-scrolling');
      clearTimeout(timers.get(el));
      timers.set(
        el,
        setTimeout(() => el.classList.remove('is-scrolling'), 700),
      );
    }
    document.addEventListener('scroll', onScroll, true);
    return () => document.removeEventListener('scroll', onScroll, true);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const onChange = () => {
      const mobile = mq.matches;
      setIsMobile(mobile);
      if (mobile) {
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
      if (isMobile || chatCollapsed) return;
      dragRef.current = { startX: clientX, startW: chatW };
      setResizing(true);
    },
    [isMobile, chatCollapsed, chatW],
  );

  useEffect(() => {
    if (!resizing) return;
    function onMove(e) {
      const d = dragRef.current;
      if (!d) return;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
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
      if (chatCollapsed || isMobile) return;
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
    [chatCollapsed, isMobile, chatW, setChatWidthLive],
  );

  const toggleCollapse = useCallback(() => {
    setChatCollapsed((c) => !c);
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
  }, [videos, focusIdx, mode, onReelActivate, mobileChatOpen, reelDrawerOpen]);

  useEffect(() => {
    if (!syncPlayback) setSyncedPlaying(false);
  }, [syncPlayback]);

  useEffect(() => {
    if (compareIds.length < 2) {
      setSyncPlayback(false);
      setSyncedPlaying(false);
      setCompareCamera(null);
      return;
    }
    setCompareCamera((prev) => ({
      preset: prev?.preset || 'front',
      spin: false,
      seq: (prev?.seq ?? 0) + 1,
    }));
  }, [compareIds.length]);

  function setCompareAngle(name) {
    setCompareCamera((prev) => ({
      preset: name,
      spin: false,
      seq: (prev?.seq ?? 0) + 1,
    }));
  }

  function toggleCompareSpin() {
    setCompareCamera((prev) => {
      const spin = !prev?.spin;
      return {
        preset: spin ? null : prev?.preset,
        spin,
        seq: (prev?.seq ?? 0) + 1,
      };
    });
  }

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

  const layoutStyle = isMobile
    ? undefined
    : {
        '--chat-w': chatCollapsed ? `${CHAT_RAIL_W}px` : `${chatW}px`,
      };

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
    collapsed: chatCollapsed,
    onToggleCollapse: toggleCollapse,
  };

  const compareControls = (
    <div className="compare-controls">
      <label className="sync-toggle">
        <input
          type="checkbox"
          checked={syncPlayback}
          onChange={(e) => setSyncPlayback(e.target.checked)}
        />
        <span className="sync-toggle-box" aria-hidden />
        <span>sync playback</span>
      </label>
      <div className="compare-controls-angle" role="group" aria-label="Angle">
        <span className="compare-view-label">angle</span>
        <div className="brain-view-group">
          {COMPARE_VIEWS.map((name) => {
            const active = compareCamera?.preset === name && !compareCamera?.spin;
            return (
              <button
                key={name}
                type="button"
                className={`brain-view-btn${active ? ' is-active' : ''}`}
                aria-pressed={active}
                title={`Point every brain ${name}`}
                onClick={() => setCompareAngle(name)}
              >
                {name[0]}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className={`brain-spin-toggle${compareCamera?.spin ? ' is-active' : ''}`}
          aria-pressed={compareCamera?.spin}
          title={compareCamera?.spin ? 'Spinning every brain' : 'Auto-spin every brain'}
          onClick={toggleCompareSpin}
        >
          spin
        </button>
      </div>
      {isMobile && <span className="compare-controls-hint">swipe for next reel</span>}
    </div>
  );

  const compareCards = (
    <div className="compare-grid scroll-pane">
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
          <div className="compare-card-head">
            <ReelId id={v.id} variant="stage" />
          </div>
          <div className="compare-card-desc">
            {[v.account, v.annotations?.format].filter(Boolean).join(' · ')}
          </div>
          <ReelStage
            video={v}
            brain={brain}
            networks={networksById[v.id]}
            layout="stack"
            syncPlayback={syncPlayback}
            syncedPlaying={syncedPlaying}
            onSyncPlayChange={setSyncedPlaying}
            onViewMoment={onViewMoment}
            masterCamera={compareCamera}
          />
        </div>
      ))}
    </div>
  );

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
        className={`layout-grid ${isMobile ? 'layout-grid-mobile' : ''} ${chatCollapsed ? 'layout-grid-collapsed' : ''}`}
        style={layoutStyle}
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
              {COMPARE_CAP_MSG}
            </div>
          )}

          <div className="reel-list-wrap flex-1 min-h-0 relative">
            <div
              ref={listRef}
              className="h-full overflow-y-auto px-4 pb-4 space-y-1 scroll-pane scroll-pane-y"
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
                        <div className="reel-id">{v.id}</div>
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

        <main
          className={`main-stage overflow-x-hidden p-4 min-w-0${
            mode === 'compare' && compareVideos.length >= 2
              ? ' main-stage-compare'
              : ' overflow-y-auto scroll-pane scroll-pane-y'
          }`}
          style={{ background: 'var(--bg)' }}
        >
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
            <div className={compareVideos.length >= 2 ? 'compare-shell' : 'flex flex-col gap-3'}>
              {compareVideos.length === 0 ? (
                <div
                  className="text-[13px] tracking-[0.03em] py-12 text-center"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  select up to {COMPARE_CAP} reels from the list
                </div>
              ) : compareVideos.length >= 2 ? (
                <CompareVerdictLayout videos={compareVideos} controls={compareControls}>
                  {compareCards}
                </CompareVerdictLayout>
              ) : (
                compareCards
              )}
            </div>
          )}
        </main>

        {!isMobile && (
          <aside
            className={`chat-column border-l hairline min-h-0 min-w-0 relative ${resizing ? 'is-resizing' : ''}`}
            style={{ background: 'var(--bg)' }}
          >
            {!chatCollapsed && (
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
              <span className="ask-glyph" aria-hidden>?</span>
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
                    {COMPARE_CAP_MSG}
                  </div>
                )}
                <div className="reel-drawer-list scroll-pane scroll-pane-y">
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
                            <div className="reel-id">{v.id}</div>
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
