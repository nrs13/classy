import { useEffect, useMemo, useRef, useState } from 'react';
import BrainViewer from './BrainViewer';
import { loadActivation } from '../lib/data';

const TIER_CLASS = {
  breakout: 'tier-breakout',
  strong: 'tier-strong',
  mid: 'tier-mid',
  tail: 'tier-tail',
};

function fmt(n) {
  if (n == null) return '-';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

/** Mean activation per frame → 0..1 curve for the timeline strip. */
function meanCurve(activation, bins = 48) {
  if (!activation?.data || !activation.frames) return null;
  const { data, frames, vertexCount: n } = activation;
  if (!n) return null;
  const means = new Float32Array(frames);
  // Normalize by the actual peak mean — sparse real activations sit well
  // below 1.0, so seeding globalMax at 1 crushed every bar to ~flat cool blue.
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

/** Muted loading placeholder — not a fake "correct" curve. */
function loadingCurve(bins = 48) {
  return Array.from({ length: bins }, () => 0.22);
}

function MuteGlyph({ muted }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M2.5 5.5h2L7.5 3v8L4.5 8.5h-2v-3z" stroke="#fff" strokeWidth="1.2" />
      {muted ? (
        <path d="M9 5l3 3M12 5l-3 3" stroke="#fff" strokeWidth="1.2" />
      ) : (
        <>
          <path d="M9 5.2c.9.7.9 2.9 0 3.6" stroke="#fff" strokeWidth="1.2" />
          <path d="M10.6 3.8c1.6 1.2 1.6 5.2 0 6.4" stroke="#fff" strokeWidth="1.2" />
        </>
      )}
    </svg>
  );
}

/**
 * @param {'split'|'stack'} layout — explore uses split (video|brain); compare uses stack
 * @param {boolean} compact — legacy alias for layout="stack"
 */
export default function ReelStage({
  video,
  brain,
  compact = false,
  layout,
  syncPlayback = false,
  syncedPlaying = false,
  onSyncPlayChange,
}) {
  const stack = layout === 'stack' || compact;
  const videoRef = useRef(null);
  /** Single source of truth for scrubber, chart playhead, and brain paint. */
  const progressRef = useRef(0);
  const scrubberRef = useRef(null);
  const playheadRef = useRef(null);
  const timeLabelRef = useRef(null);
  const [activation, setActivation] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [hasVideo, setHasVideo] = useState(true);
  const [muted, setMuted] = useState(true);
  const [hovered, setHovered] = useState(false);
  const [duration, setDuration] = useState(video.duration || 0);
  const clockRef = useRef(0);
  const applyingSync = useRef(false);
  const durationRef = useRef(duration);
  const playingRef = useRef(playing);
  const hasVideoRef = useRef(hasVideo);
  const lastStateProgress = useRef(0);

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
    let alive = true;
    // Clear only while loading this reel — never leave a stale curve painted
    // as if it belonged to the new selection.
    setActivation(null);
    loadActivation(video, brain).then((a) => {
      if (!alive) return;
      // Prefer real (or synthetic-from-loader) data; never overwrite a prior
      // real load with a later stale response (Strict Mode / fast reel flips).
      setActivation(a);
    });
    return () => {
      alive = false;
    };
  }, [video.id, brain]);

  /** Push the same progress value to scrubber fill, playhead, timestamp, and React state. */
  function applyProgress(p, { forceState = false } = {}) {
    const clamped = Math.max(0, Math.min(1, p));
    progressRef.current = clamped;
    const pct = `${(clamped * 100).toFixed(4)}%`;
    const scrub = scrubberRef.current;
    if (scrub) {
      scrub.style.setProperty('--progress', pct);
      // Keep native range thumb in lockstep without waiting on React.
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
    // Coalesce React state updates so controlled input stays honest without thrashing.
    if (forceState || Math.abs(clamped - lastStateProgress.current) > 0.012) {
      lastStateProgress.current = clamped;
      setProgress(clamped);
    }
  }

  useEffect(() => {
    let raf;
    let prev = performance.now();
    const tick = (now) => {
      const dt = (now - prev) / 1000;
      prev = now;
      const vid = videoRef.current;
      let p;
      if (hasVideoRef.current && vid && isFinite(vid.duration) && vid.duration > 0) {
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
    // Stable loop: read latest flags via refs so we don't tear down rAF on play/pause.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video.id]);

  useEffect(() => {
    const vid = videoRef.current;
    if (vid) vid.muted = muted;
  }, [muted]);

  // Apply synced play/pause from parent when sync is on.
  useEffect(() => {
    if (!syncPlayback) return;
    const vid = videoRef.current;
    applyingSync.current = true;
    if (hasVideo && vid && isFinite(vid.duration) && vid.duration > 0) {
      if (syncedPlaying) {
        vid.play().catch(() => {});
      } else {
        vid.pause();
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
  }

  function togglePlay() {
    const next = !playing;
    if (syncPlayback && onSyncPlayChange) {
      onSyncPlayChange(next);
    } else {
      setLocalPlaying(next);
    }
  }

  function seek(frac) {
    const f = Math.max(0, Math.min(1, frac));
    const vid = videoRef.current;
    if (hasVideo && vid && isFinite(vid.duration) && vid.duration > 0) {
      vid.currentTime = f * vid.duration;
    } else {
      clockRef.current = f;
    }
    applyProgress(f, { forceState: true });
  }

  const bins = stack ? 32 : 56;
  const curve = useMemo(() => meanCurve(activation, bins), [activation, bins]);
  // Placeholder only before real data arrives — never after.
  const barCurve = curve || loadingCurve(bins);
  const barsReady = Boolean(curve);

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
      <video
        ref={videoRef}
        src={`/data/${video.video}`}
        className="w-full h-full object-contain"
        playsInline
        muted={muted}
        loop
        onLoadedData={(e) => {
          setHasVideo(true);
          if (e.currentTarget.duration) setDuration(e.currentTarget.duration);
        }}
        onError={() => setHasVideo(false)}
      />
      {!hasVideo && (
        <div
          className="absolute inset-0 grid place-items-center text-[11px] text-center px-4 tracking-[0.04em]"
          style={{ color: 'var(--text-secondary)' }}
        >
          waiting for video
          <br />
          <span style={{ color: 'var(--text-tertiary)' }}>public/data/videos/{video.id}.mp4</span>
        </div>
      )}
      {!stack && (
        <span
          className="absolute top-2 left-2 text-[11px] font-semibold px-2 py-0.5 tracking-[0.04em]"
          style={{
            background: 'var(--bg)',
            color: 'var(--text-primary)',
            borderRadius: 'var(--radius)',
            border: '1px solid var(--border)',
          }}
        >
          {video.id}
        </span>
      )}

      <button
        type="button"
        onClick={togglePlay}
        className={`btn-overlay absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2${
          showOverlay ? ' is-visible' : ''
        }`}
        aria-label={playing ? 'Pause' : 'Play'}
        title={playing ? 'Pause' : 'Play'}
      >
        {playing ? '‖' : '▶'}
      </button>

      <button
        type="button"
        onClick={() => setMuted((v) => !v)}
        className="btn-mute absolute bottom-2 right-2"
        style={{ opacity: showOverlay ? 1 : 0 }}
        aria-label={muted ? 'Unmute' : 'Mute'}
        title={muted ? 'Unmute' : 'Mute'}
      >
        <MuteGlyph muted={muted} />
      </button>
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
        <BrainViewer brain={brain} activation={activation} progressRef={progressRef} />
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

      <div className="flex items-center gap-2 min-w-0">
        <span
          ref={timeLabelRef}
          className="text-[11px] tabular-nums shrink-0 tracking-[0.04em]"
          style={{ color: 'var(--text-secondary)', minWidth: '5.5rem' }}
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

      <div
        className={`act-timeline${barsReady ? '' : ' is-loading'}`}
        role="img"
        aria-label="Scene activation timeline"
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
      </div>

      {!stack && (
        <div className="stats-cq">
          <div className="stats-grid text-sm">
            <Stat label="Plays" value={fmt(m.plays)} />
            <Stat
              label="Like-rate"
              value={m.like_rate != null ? (m.like_rate * 100).toFixed(2) + '%' : '-'}
            />
            <Stat
              label="Amplification"
              value={m.amplification != null ? m.amplification + '×' : '-'}
            />
            <Stat
              label="Tier"
              value={video.tier ? `[${video.tier}]` : '-'}
              cls={TIER_CLASS[video.tier] || ''}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, cls = '' }) {
  const full = value == null ? '-' : String(value);
  return (
    <div className="stat-tile px-3 py-2 min-w-0">
      <div className="section-label stat-tile-label mb-1">{label}</div>
      <div className={`stat-tile-value font-semibold tracking-[0.03em] ${cls}`} title={full}>
        {full}
      </div>
    </div>
  );
}
