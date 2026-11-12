import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
const BrainViewer = lazy(() => import('./BrainViewer'));
import { ErrorBoundary } from './ErrorBoundary';
import { BRAIN_FALLBACK } from '../lib/boundary';
import Receipt from './Receipt';
import VideoId from './VideoId';
import { loadActivation, SECONDS_UNAVAILABLE, secondsFailed } from '../lib/data';
import { apiFetch } from '../lib/apiFetch';
import { cutMarks, sentencesAt, timingSource } from '../lib/forecast';
import { whyLine } from '../lib/search';
import { hasApp, hasAsk, hasOutcome, nextMark, receiptAt, receiptView, secondsFromRecord } from '../lib/receipt';
import { YEO7_ROLES } from '../lib/yeo7';
import { amplificationLabel, compactCount } from '../lib/figures';

const TIER_CLASS = {
  breakout: 'tier-breakout',
  strong: 'tier-strong',
  mid: 'tier-mid',
  tail: 'tier-tail',
};

function fmt(n) {
  return compactCount(n) || '-';
}

function fmtAmp(n) {
  return amplificationLabel(n) || '-';
}

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function meanCurve(activation, bins = 48) {
  if (!activation?.data || !activation.frames) return null;
  const { data, frames, vertexCount: n } = activation;
  if (!n) return null;
  const means = new Float32Array(frames);
  let globalMax = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const base = f * n;
    for (let v = 0; v < n; v++) sum += data[base + v];
    means[f] = sum / (n * 255);
    if (means[f] > globalMax) globalMax = means[f];
  }
  if (globalMax < 1e-8) return null;
  const out = new Array(bins);
  for (let i = 0; i < bins; i++) {
    const t = bins === 1 ? 0 : i / (bins - 1);
    const fi = Math.min(frames - 1, Math.floor(t * (frames - 1)));
    out[i] = means[fi] / globalMax;
  }
  return out;
}

function loadingCurve(bins = 48) {
  return Array.from({ length: bins }, () => 0.22);
}

function MuteGlyph({ muted }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M2.5 5.5h2L7.5 3v8L4.5 8.5h-2v-3z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      {muted ? (
        <path d="M9 5l3 3M12 5l-3 3" stroke="currentColor" strokeWidth="1.2" />
      ) : (
        <>
          <path d="M9 5.2c.9.7.9 2.9 0 3.6" stroke="currentColor" strokeWidth="1.2" />
          <path d="M10.6 3.8c1.6 1.2 1.6 5.2 0 6.4" stroke="currentColor" strokeWidth="1.2" />
        </>
      )}
    </svg>
  );
}

function PlayGlyph({ playing }) {
  const stroke = {
    stroke: 'rgba(0,0,0,0.88)',
    strokeWidth: 1.35,
    strokeLinejoin: 'round',
    paintOrder: 'stroke fill',
  };
  return playing ? (
    <svg width="28" height="28" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M4 3h2.2v8H4V3zm3.8 0H10v8H7.8V3z" fill="currentColor" {...stroke} />
    </svg>
  ) : (
    <svg width="28" height="28" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M4.2 2.8v8.4L11.4 7 4.2 2.8z" fill="currentColor" {...stroke} />
    </svg>
  );
}

function noteText(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === '[]' || raw === '{}') return '';
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => {
            if (typeof item === 'string') return item.trim();
            return String(item?.name || item?.text || '').trim();
          })
          .filter(Boolean)
          .join(', ');
      }
    } catch {
      return raw;
    }
  }
  return raw;
}

export default function VideoStage({
  video,
  brain,
  networks,
  layout,
  syncPlayback = false,
  syncedPlaying = false,
  onSyncPlayChange,
  onViewMoment,
  masterCamera = null,
  record = null,
  seekRequest = null,
  sharedClock = null,
  onSharedSeek = null,
  onSharedPlay = null,
  onSharedDuration = null,
  searchHit = null,
}) {
  const stack = layout === 'stack';
  const videoRef = useRef(null);
  const progressRef = useRef(0);
  const scrubberRef = useRef(null);
  const playheadRef = useRef(null);
  const timeLabelRef = useRef(null);
  const [activation, setActivation] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [hasVideo, setHasVideo] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [slowVideo, setSlowVideo] = useState(false);
  const stallTimer = useRef(null);
  const [muted, setMuted] = useState(true);
  const [hovered, setHovered] = useState(false);
  const [hoverNetwork, setHoverNetwork] = useState(null);
  const [selectedNetwork, setSelectedNetwork] = useState(null);
  const [duration, setDuration] = useState(video.duration || 0);
  const clockRef = useRef(0);
  const applyingSync = useRef(false);
  const durationRef = useRef(duration);
  const playingRef = useRef(playing);
  const hasVideoRef = useRef(hasVideo);
  const lastStateProgress = useRef(0);
  const lastFloor = useRef(-1);
  const appliedSeek = useRef(0);
  const [packedSeconds, setPackedSeconds] = useState(null);
  const [secondsError, setSecondsError] = useState(false);
  const [secondsTry, setSecondsTry] = useState(0);
  const [mediaSrc, setMediaSrc] = useState('');
  const controlled = Boolean(sharedClock);
  const handleNetworkChange = useCallback((next) => {
    if (next == null || typeof next === 'string') {
      setHoverNetwork(typeof next === 'string' ? next : null);
      setSelectedNetwork(null);
      return;
    }
    setHoverNetwork(next.hover ?? null);
    setSelectedNetwork(next.selected ?? null);
  }, []);

  useEffect(() => {
    durationRef.current = duration;
  }, [duration]);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);
  useEffect(() => {
    hasVideoRef.current = hasVideo;
  }, [hasVideo]);

  useEffect(() => {
    setHasVideo(false);
    setVideoFailed(false);
    setPlaying(false);
    setProgress(0);
    clockRef.current = 0;
    progressRef.current = 0;
  }, [video.id]);

  useEffect(() => {
    if (!hasVideo) return undefined;
    const ctrl = new AbortController();
    setActivation(null);
    loadActivation(video, brain, { signal: ctrl.signal }).then((a) => {
      if (!ctrl.signal.aborted) setActivation(a);
    });
    return () => ctrl.abort();
  }, [video.id, brain, hasVideo]);

  useEffect(() => {
    const ctrl = new AbortController();
    setPackedSeconds(null);
    setSecondsError(false);
    apiFetch(`/api/seconds?id=${encodeURIComponent(video.id)}`, { signal: ctrl.signal })
      .then((res) => {
        if (secondsFailed(ctrl.signal, res)) throw new Error('seconds');
        return res.json();
      })
      .then((data) => {
        if (!ctrl.signal.aborted) setPackedSeconds(data);
      })
      .catch((err) => {
        if (ctrl.signal.aborted || err?.name === 'AbortError') return;
        setPackedSeconds(null);
        setSecondsError(true);
      });
    return () => ctrl.abort();
  }, [video.id, secondsTry]);

  const [mediaTry, setMediaTry] = useState(0);
  const [stallNonce, setStallNonce] = useState(0);

  useEffect(() => {
    setMediaTry(0);
  }, [video.id]);

  useEffect(() => {
    const ctrl = new AbortController();
    setMediaSrc('');
    apiFetch(`/api/media?id=${encodeURIComponent(video.id)}&kind=mp4`, { signal: ctrl.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!ctrl.signal.aborted && body?.url) setMediaSrc(body.url);
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setMediaSrc('');
      });
    return () => ctrl.abort();
  }, [video.id, mediaTry, stallNonce]);

  function beginStall() {
    setBuffering(true);
    if (stallTimer.current) return;
    stallTimer.current = setTimeout(() => setSlowVideo(true), 10_000);
  }

  function endStall() {
    setBuffering(false);
    setSlowVideo(false);
    if (stallTimer.current) clearTimeout(stallTimer.current);
    stallTimer.current = null;
  }

  function applyProgress(p, { forceState = false } = {}) {
    const clamped = Math.max(0, Math.min(1, p));
    progressRef.current = clamped;
    const pct = `${(clamped * 100).toFixed(4)}%`;
    const scrub = scrubberRef.current;
    if (scrub) {
      scrub.style.setProperty('--progress', pct);
      if (document.activeElement !== scrub) {
        scrub.value = String(clamped);
      }
    }
    if (playheadRef.current) {
      playheadRef.current.style.left = pct;
    }
    const total = durationRef.current || video.duration || 0;
    if (timeLabelRef.current) {
      timeLabelRef.current.textContent = `${fmtTime(clamped * total)} / ${fmtTime(total)}`;
    }
    const floor = Math.floor(clamped * total);
    if (floor !== lastFloor.current) {
      lastFloor.current = floor;
      forceState = true;
    }
    if (forceState || Math.abs(clamped - lastStateProgress.current) > 0.012) {
      lastStateProgress.current = clamped;
      setProgress(clamped);
    }
  }

  function reportViewMoment() {
    if (!onViewMoment) return;
    const total = durationRef.current || video.duration || 0;
    onViewMoment({ videoId: video.id, timeSec: progressRef.current * total });
  }

  useEffect(() => {
    reportViewMoment();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video.id]);

  useEffect(() => {
    let raf;
    let prev = performance.now();
    const tick = (now) => {
      const dt = (now - prev) / 1000;
      prev = now;
      const vid = videoRef.current;
      let p;
      const clock = sharedClock?.current;
      if (clock) {
        const total = durationRef.current || video.duration || 0;
        const shown = total > 0 ? Math.min(clock.timeSec, Math.max(0, total - 0.05)) : clock.timeSec;
        if (hasVideoRef.current && vid && isFinite(vid.duration) && vid.duration > 0) {
          const jumped = clock.seekSeq !== appliedSeek.current;
          const drift = Math.abs(vid.currentTime - shown);
          if (jumped || drift > (clock.playing ? 0.28 : 0.05)) {
            appliedSeek.current = clock.seekSeq;
            try {
              vid.currentTime = Math.min(shown, vid.duration);
            } catch {
              /* ignore seek before data */
            }
          }
          if (clock.playing && vid.paused) vid.play().catch(() => {});
          if (!clock.playing && !vid.paused) vid.pause();
          if (vid.duration !== durationRef.current) setDuration(vid.duration);
        }
        if (clock.playing !== playingRef.current) setPlaying(clock.playing);
        p = total > 0 ? shown / total : 0;
      } else if (hasVideoRef.current && vid && isFinite(vid.duration) && vid.duration > 0) {
        p = vid.currentTime / vid.duration;
        if (!applyingSync.current) {
          const isPlaying = !vid.paused;
          if (isPlaying !== playingRef.current) setPlaying(isPlaying);
        }
        if (vid.duration !== durationRef.current) setDuration(vid.duration);
      } else {
        if (playingRef.current) clockRef.current += dt / (video.duration || 8);
        p = clockRef.current % 1;
      }
      applyProgress(p);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video.id, sharedClock]);

  useEffect(() => {
    const vid = videoRef.current;
    if (vid) vid.muted = muted;
  }, [muted]);

  useEffect(() => {
    if (!syncPlayback || controlled) return;
    const vid = videoRef.current;
    applyingSync.current = true;
    if (hasVideo && vid && isFinite(vid.duration) && vid.duration > 0) {
      if (syncedPlaying) {
        vid.play().catch(() => {});
      } else {
        vid.pause();
        reportViewMoment();
      }
    }
    setPlaying(syncedPlaying);
    const t = setTimeout(() => {
      applyingSync.current = false;
    }, 50);
    return () => clearTimeout(t);
  }, [syncPlayback, syncedPlaying, hasVideo]);

  function setLocalPlaying(next) {
    const vid = videoRef.current;
    if (hasVideo && vid && isFinite(vid.duration) && vid.duration > 0) {
      if (next) vid.play().catch(() => {});
      else vid.pause();
    }
    setPlaying(next);
    if (!next) reportViewMoment();
  }

  function togglePlay() {
    const next = !playing;
    if (controlled && onSharedPlay) {
      onSharedPlay(next);
      return;
    }
    if (syncPlayback && onSyncPlayChange) {
      onSyncPlayChange(next);
    } else {
      setLocalPlaying(next);
    }
  }

  function seek(frac) {
    const f = Math.max(0, Math.min(1, frac));
    const total = durationRef.current || video.duration || 0;
    if (controlled && onSharedSeek) {
      onSharedSeek(f * total);
      applyProgress(f, { forceState: true });
      reportViewMoment();
      return;
    }
    const vid = videoRef.current;
    if (hasVideo && vid && isFinite(vid.duration) && vid.duration > 0) {
      vid.currentTime = f * vid.duration;
    } else {
      clockRef.current = f;
    }
    applyProgress(f, { forceState: true });
    reportViewMoment();
  }

  function seekSeconds(sec) {
    const total = durationRef.current || video.duration || 1;
    seek(sec / total);
  }

  useEffect(() => {
    if (!seekRequest || seekRequest.videoId !== video.id) return;
    const total = durationRef.current || video.duration || seekRequest.tSec || 1;
    const frac = Math.max(0, Math.min(1, seekRequest.tSec / total));
    const vid = videoRef.current;
    if (vid && isFinite(vid.duration) && vid.duration > 0) {
      vid.currentTime = Math.min(seekRequest.tSec, vid.duration);
      vid.pause();
    } else {
      clockRef.current = frac;
    }
    setPlaying(false);
    applyProgress(frac, { forceState: true });
    reportViewMoment();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekRequest, video.id]);

  const bins = stack ? 32 : 56;
  const curve = useMemo(() => meanCurve(activation, bins), [activation, bins]);
  const barCurve = curve || loadingCurve(bins);
  const barsReady = Boolean(curve);
  const shownDuration = duration || video.duration || 0;
  const timeSec = progress * shownDuration;
  const seconds = useMemo(() => {
    if (Array.isArray(packedSeconds?.seconds) && packedSeconds.seconds.length) {
      return packedSeconds.seconds;
    }
    return secondsFromRecord(record);
  }, [packedSeconds, record]);
  const timing = timingSource(video, packedSeconds);
  const marks = cutMarks(timing?.cuts, shownDuration);
  const contentMarks = useMemo(() => {
    if (!shownDuration) return [];
    return seconds
      .filter((row) => {
        const view = receiptView(row);
        return Boolean(view.speech || view.text.length || view.scenes.length);
      })
      .map((row) => ({
        t: Number(row.t_sec),
        left: (Number(row.t_sec) / shownDuration) * 100,
      }))
      .filter((mark) => mark.left >= 0 && mark.left <= 100);
  }, [seconds, shownDuration]);
  const forecastLines = sentencesAt(timing, timeSec);
  const receipt = receiptAt(seconds, timeSec);
  const askAt = nextMark(seconds, timeSec, hasAsk);
  const outcomeAt = nextMark(seconds, timeSec, hasOutcome);
  const appAt = nextMark(seconds, timeSec, hasApp);
  const jumpCount = [askAt, outcomeAt, appAt].filter((t) => t != null).length;

  const m = video.metrics || {};
  const showOverlay = hovered || !playing;
  const brainReady = Boolean(brain);

  const videoBlock = (
    <div
      className={`relative overflow-hidden surface bg-black group ${
        stack ? 'stage-video-stack' : 'stage-video-split'
      }`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="stage-video-frame">
      <video
        ref={videoRef}
        src={mediaSrc || undefined}
        className={`w-full h-full object-contain stage-video-el${hasVideo ? ' is-ready' : ''}`}
        playsInline
        muted={muted}
        loop={!controlled}
        preload="metadata"
        onWaiting={beginStall}
        onStalled={beginStall}
        onPlaying={endStall}
        onCanPlay={endStall}
        onLoadedData={(e) => {
          setHasVideo(true);
          setVideoFailed(false);
          const vid = e.currentTarget;
          if (vid.duration) {
            setDuration(vid.duration);
            onSharedDuration?.(video.id, vid.duration);
          }
          const pending = seekRequest;
          if (pending?.videoId === video.id && vid.duration) {
            vid.currentTime = Math.min(pending.tSec, vid.duration);
            vid.pause();
            setPlaying(false);
          } else if (vid.currentTime < 0.05 && vid.duration > 0.25) {
            try {
              vid.currentTime = 0.08;
            } catch {
              /* ignore seek failures before enough data */
            }
          }
        }}
        onError={() => {
          setHasVideo(false);
          if (mediaTry < 1) {
            setMediaTry(1);
            return;
          }
          setVideoFailed(true);
        }}
      />
      {!hasVideo && (
        <div
          className="stage-video-loading"
          aria-live="polite"
          aria-busy={!videoFailed}
        >
          {videoFailed ? 'unavailable' : 'loading'}
        </div>
      )}
      {hasVideo && buffering && (
        <div className="stage-video-loading" role="status">
          {slowVideo ? 'Connection is slow' : 'Buffering'}
          {slowVideo && (
            <button type="button" className="chat-send-btn" onClick={() => { endStall(); setStallNonce((n) => n + 1); }}>
              Retry
            </button>
          )}
        </div>
      )}
      {!stack && (
        <VideoId
          id={video.id}
          variant="stage"
          onDark
          className="absolute top-2 left-2 z-[2]"
        />
      )}

      <button
        type="button"
        onClick={togglePlay}
        className={`btn-media btn-media-play absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2${
          showOverlay ? ' is-visible' : ''
        }`}
        aria-label={playing ? 'Pause' : 'Play'}
        title={playing ? 'Pause' : 'Play'}
      >
        <span className="btn-media-play-glyph">
          <PlayGlyph playing={playing} />
        </span>
      </button>

      <button
        type="button"
        onClick={() => setMuted((v) => !v)}
        className={`btn-media btn-media-mute${showOverlay ? ' is-visible' : ''}`}
        aria-label={muted ? 'Unmute' : 'Mute'}
        aria-pressed={muted}
        title={muted ? 'Unmute' : 'Mute'}
      >
        <MuteGlyph muted={muted} />
      </button>
      </div>
    </div>
  );

  const brainBlock = (
    <div
      className={`overflow-hidden surface relative stage-brain ${
        stack ? 'stage-brain-stack' : 'stage-brain-split'
      }`}
      data-frames={activation ? activation.frames : 0}
      data-verts={brain ? brain.vertexCount : 0}
    >
      {!brainReady && (
        <div className="sphere-loading" aria-hidden>
          <div className="sphere-loading-box" />
        </div>
      )}
      {brainReady && (
        <ErrorBoundary
          key={video.id}
          scope="brain"
          fallback={
            <div className="brain-fallback" role="status">
              {BRAIN_FALLBACK}
            </div>
          }
        >
          <Suspense fallback={null}>
            <BrainViewer
              brain={brain}
              activation={activation}
              progressRef={progressRef}
              videoId={video.id}
              timeSec={progress * (duration || video.duration || 0)}
              onNetworkChange={handleNetworkChange}
              compact={stack}
            masterCamera={masterCamera}
          />
          </Suspense>
        </ErrorBoundary>
      )}
    </div>
  );

  return (
    <div className={`stage-host flex flex-col ${stack ? 'gap-2' : 'gap-3'}`}>
      {stack ? (
        <div className="stage-stack">
          {videoBlock}
          {brainBlock}
        </div>
      ) : (
        <div className="stage-split">
          {videoBlock}
          {brainBlock}
        </div>
      )}

      <div className="stage-transport flex items-center gap-2 min-w-0">
        <span
          ref={timeLabelRef}
          className="time-readout text-[11px] tabular-nums shrink-0 tracking-[0.04em]"
          style={{ minWidth: '5.5rem' }}
        >
          {fmtTime(progress * (duration || video.duration || 0))} /{' '}
          {fmtTime(duration || video.duration || 0)}
        </span>
        <input
          ref={scrubberRef}
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={progress}
          onChange={(e) => seek(parseFloat(e.target.value))}
          className="scrubber flex-1 min-w-0"
          aria-label="Scrub"
        />
      </div>

      <div className="curve-block">
        <div className="section-label">Predicted curve</div>
        {secondsError && (
          <p className="seconds-error" role="alert">
            {SECONDS_UNAVAILABLE}
            <button type="button" onClick={() => setSecondsTry((n) => n + 1)}>
              Retry
            </button>
          </p>
        )}
      <div
        className={`act-timeline${barsReady ? '' : ' is-loading'}`}
        role="img"
        aria-label="Predicted curve. Click to move the playhead."
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          seek((e.clientX - rect.left) / rect.width);
        }}
      >
        <div className="act-timeline-bars">
          {barCurve.map((h, i) => (
            <div
              key={i}
              className="act-timeline-bar"
              style={{
                height: `${Math.max(8, h * 100)}%`,
                '--bar-t': String(h),
              }}
            />
          ))}
        </div>
        <div ref={playheadRef} className="act-playhead" />
        {marks.map((mark) => (
          <div
            key={`${mark.kind}-${mark.t}`}
            className={`act-mark${mark.kind === 'cut' ? ' act-mark-cut' : ' act-mark-lag'}`}
            style={{ left: `${mark.left}%` }}
            title={mark.kind === 'cut' ? 'Cut' : mark.kind === 'lag1' ? 'One second after a cut' : 'Two seconds after a cut'}
          />
        ))}
        {contentMarks.map((mark) => (
          <div
            key={`content-${mark.t}`}
            className="act-content-mark"
            style={{ left: `${mark.left}%` }}
            title="Extracted speech or text"
          />
        ))}
      </div>
      </div>

      <Receipt
        row={receipt}
        quoteFloor={packedSeconds?.quoteFloor}
        searchNote={
          searchHit?.videoId === video.id
            ? `Opened from search. ${whyLine(searchHit)}.`
            : ''
        }
      />

      {forecastLines.length > 0 && (
        <div className="forecast-note">
          {forecastLines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}

      {jumpCount > 0 && (
        <div className="jump-row">
          {askAt != null && (
            <button type="button" className="jump-btn" onClick={() => seekSeconds(askAt)}>
              Next agreed ask
            </button>
          )}
          {outcomeAt != null && (
            <button type="button" className="jump-btn" onClick={() => seekSeconds(outcomeAt)}>
              Next outcome
            </button>
          )}
          {appAt != null && (
            <button type="button" className="jump-btn" onClick={() => seekSeconds(appAt)}>
              Next agreed app
            </button>
          )}
        </div>
      )}

      <div className="stats-cq">
        {stack ? (
          <NetworkStat
            networks={networks}
            hoverNetwork={hoverNetwork}
            selectedNetwork={selectedNetwork}
          />
        ) : (
          <div className="stats-grid text-sm">
            <Stat label="Plays" value={fmt(m.plays)} />
            <Stat
              label="Like-rate"
              value={m.like_rate != null ? (m.like_rate * 100).toFixed(2) + '%' : '-'}
            />
            <Stat
              label="Amplification"
              value={fmtAmp(m.amplification)}
              full={m.amplification != null ? `${m.amplification}×` : null}
            />
            <Stat
              label="Tier"
              value={video.tier ? `[${video.tier}]` : '-'}
              cls={TIER_CLASS[video.tier] || ''}
            />
            <NetworkStat
              networks={networks}
              hoverNetwork={hoverNetwork}
              selectedNetwork={selectedNetwork}
            />
          </div>
        )}
      </div>

      {!stack && (video.account || video.language || noteText(video.topics) || noteText(video.keywords) || video.annotations?.key_elements || video.annotations?.relatability_hook) && (
        <div className="video-notes">
          <div className="section-label stat-tile-label">About this video</div>
          <dl className="video-notes-grid">
            {video.account && (
              <>
                <dt>Account</dt>
                <dd>
                  {video.profileUrl ? (
                    <a href={video.profileUrl} target="_blank" rel="noreferrer noopener">
                      @{video.account}
                    </a>
                  ) : (
                    <>@{video.account}</>
                  )}
                </dd>
              </>
            )}
            {video.language && (
              <>
                <dt>Language</dt>
                <dd>{video.language}</dd>
              </>
            )}
            {noteText(video.topics) && (
              <>
                <dt>Topics</dt>
                <dd>{noteText(video.topics)}</dd>
              </>
            )}
            {noteText(video.keywords) && (
              <>
                <dt>Keywords</dt>
                <dd>{noteText(video.keywords)}</dd>
              </>
            )}
            {video.annotations?.key_elements && (
              <>
                <dt>Key elements</dt>
                <dd>{video.annotations.key_elements}</dd>
              </>
            )}
            {video.annotations?.relatability_hook && (
              <>
                <dt>Relatability hook</dt>
                <dd>{video.annotations.relatability_hook}</dd>
              </>
            )}
          </dl>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, cls = '', full = null }) {
  const shown = value == null ? '-' : String(value);
  return (
    <div className="stat-tile px-3 py-2 min-w-0">
      <div className="section-label stat-tile-label mb-1">{label}</div>
      <div className={`stat-tile-value tracking-[0.03em] ${cls}`} title={full ?? shown}>
        {shown}
      </div>
    </div>
  );
}

function NetworkStat({ networks, hoverNetwork, selectedNetwork }) {
  const means = networks?.means || {};
  const topNetworks = networks?.top || [];
  const rankedAll = Object.keys(means).sort(
    (a, b) => (Number(means[b]) || 0) - (Number(means[a]) || 0),
  );
  const rankOf = (name) => {
    const index = rankedAll.indexOf(name);
    return index >= 0 ? index + 1 : null;
  };

  const rows = topNetworks.map((name, index) => ({
    name,
    rank: index + 1,
    mean: Number(means[name]) || 0,
    selected: false,
  }));

  const selectedRank =
    selectedNetwork && !topNetworks.includes(selectedNetwork)
      ? rankOf(selectedNetwork)
      : null;
  const selectedRow =
    selectedRank != null
      ? {
          name: selectedNetwork,
          rank: selectedRank,
          mean: Number(means[selectedNetwork]) || 0,
          selected: true,
        }
      : null;

  const maxMean = Math.max(
    0,
    ...Object.values(means).map((v) => Number(v) || 0),
  );
  const highlightName = hoverNetwork || selectedNetwork;

  const renderRow = (network) => {
    const active = highlightName === network.name;
    const level = maxMean > 0 ? network.mean / maxMean : 0;
    const role = YEO7_ROLES[network.name];
    return (
      <div
        key={network.name}
        className={`brain-network-row${active ? ' is-active' : ''}${
          network.selected ? ' is-selected' : ''
        }`}
        data-network={network.name}
        data-active={active ? 'true' : 'false'}
      >
        <div className="brain-network-label">
          <span>{network.rank}</span>
          <span>
            {network.name}
            {network.selected ? (
              <span className="brain-network-selected-tag"> selected</span>
            ) : null}
          </span>
          <span title="Mean absolute predicted activation, in unitless model output">
            {network.mean.toFixed(3)}
          </span>
        </div>
        {role && <div className="brain-network-role">{role}</div>}
        <div className="brain-network-track">
          <div
            className="brain-network-bar"
            style={{ '--network-level': String(level) }}
          />
        </div>
      </div>
    );
  };

  return (
    <div className="stat-tile network-stat-tile px-3 py-2 min-w-0">
      <div className="section-label stat-tile-label mb-1">Top 3 networks</div>
      <div className="brain-network-list" aria-label="Top Yeo-7 networks">
        {rows.map(renderRow)}
        {selectedRow ? renderRow(selectedRow) : null}
      </div>
    </div>
  );
}
