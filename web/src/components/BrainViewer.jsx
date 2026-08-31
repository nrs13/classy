import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { turboLUT } from '../lib/colormap';
import ReelId from './ReelId';

const FIT_RADIUS = 2.4;
const VIEW_DISTANCE = 5.8;
const VIEW_PRESETS = {
  front: [0, 0.35, VIEW_DISTANCE],
  left: [-VIEW_DISTANCE, 0.35, 0],
  right: [VIEW_DISTANCE, 0.35, 0],
  back: [0, 0.35, -VIEW_DISTANCE],
};
const VIEW_ORDER = ['front', 'left', 'right', 'back'];
const HOVER_INTERVAL_MS = 80;
const HOVER_MOVE_PX = 6;
const TAP_MOVE_PX = 8;
const TOUCH_TAP_SLOP_PX = 16;
const TAP_MAX_MS = 450;
const LONG_PRESS_MS = 525;
/** Cancel arming isolate sooner than full touch-tap slop so slow orbits don't isolate. */
const LONG_PRESS_CANCEL_PX = 6;
const SELECT_DEBOUNCE_MS = 60;
const DRAG_GUARD_MS = 520;
const PIN_SUPPRESS_MS = 520;

function tapSlopFor(pointerType) {
  return pointerType === 'touch' ? TOUCH_TAP_SLOP_PX : TAP_MOVE_PX;
}

function isDragGesture(canvasGesture, pointerType, from, x, y) {
  if (canvasGesture?.current?.moved) return true;
  if (performance.now() < (canvasGesture?.current?.dragGuardUntil || 0)) return true;
  if (!from) return false;
  return Math.hypot(x - from.x, y - from.y) > tapSlopFor(pointerType || from.pointerType);
}

function isTouchPointer(pointerType) {
  return pointerType === 'touch' || pointerType === 'pen';
}
const TURBO_LEGEND_BACKGROUND = `linear-gradient(90deg, ${[0, 51, 102, 153, 204, 255]
  .map((value) => {
    const offset = value * 3;
    return `rgb(${turboLUT[offset]} ${turboLUT[offset + 1]} ${turboLUT[offset + 2]}) ${
      (value / 2.55).toFixed(0)
    }%`;
  })
  .join(', ')})`;

function paintFrame(colors, data, frame, n) {
  const base = frame * n;
  for (let v = 0; v < n; v++) {
    const a = data[base + v];
    const li = a * 3;
    colors[v * 3] = turboLUT[li] / 255;
    colors[v * 3 + 1] = turboLUT[li + 1] / 255;
    colors[v * 3 + 2] = turboLUT[li + 2] / 255;
  }
}

function eventCoords(event) {
  const source = event.nativeEvent || event;
  return {
    x: Number(source.clientX) || 0,
    y: Number(source.clientY) || 0,
    pointerType: source.pointerType || event.pointerType || 'mouse',
    isPrimary: source.isPrimary !== false,
  };
}

function nearestFaceVertex(event, geometry) {
  if (!event.face || !event.point || !event.object) return null;
  const localPoint = event.object.worldToLocal(event.point.clone());
  const position = geometry.attributes.position;
  const candidates = [event.face.a, event.face.b, event.face.c];
  const vertex = new THREE.Vector3();
  let nearest = null;
  let nearestDistance = Infinity;
  for (const index of candidates) {
    vertex.fromBufferAttribute(position, index);
    const distance = vertex.distanceToSquared(localPoint);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = index;
    }
  }
  return nearest;
}

function buildNetworkGroups(labels) {
  const pending = new Map();
  let cortexVertexCount = 0;
  for (let index = 0; index < labels.length; index++) {
    const labelId = labels[index];
    if (!labelId) continue;
    cortexVertexCount++;
    if (!pending.has(labelId)) pending.set(labelId, []);
    pending.get(labelId).push(index);
  }
  const byLabel = new Map();
  for (const [labelId, indices] of pending) {
    byLabel.set(labelId, Uint32Array.from(indices));
  }
  return { byLabel, cortexVertexCount };
}

/** Live turbo colors for the isolated vertex set only (playback color pass). */
function paintIsolatedColors(colors, activation, frame, networkIndices) {
  const base = frame * activation.vertexCount;
  for (const vertex of networkIndices) {
    const colorOffset = vertex * 3;
    const lutOffset = activation.data[base + vertex] * 3;
    colors[colorOffset] = turboLUT[lutOffset] / 255;
    colors[colorOffset + 1] = turboLUT[lutOffset + 1] / 255;
    colors[colorOffset + 2] = turboLUT[lutOffset + 2] / 255;
  }
}

/**
 * Mask pass: dim non-isolated vertices, restore isolated set at `frame`.
 * Event-driven only (enter / exit / switch network) — not every playback tick.
 */
function applyIsolateMask(colors, activation, frame, n, networkIndices) {
  paintFrame(colors, activation.data, frame, n);
  for (let vertex = 0; vertex < n; vertex++) {
    const offset = vertex * 3;
    const gray =
      colors[offset] * 0.2126 + colors[offset + 1] * 0.7152 + colors[offset + 2] * 0.0722;
    const dimmed = Math.min(1, 0.025 + gray * 0.32);
    colors[offset] = dimmed;
    colors[offset + 1] = dimmed;
    colors[offset + 2] = dimmed;
  }
  paintIsolatedColors(colors, activation, frame, networkIndices);
}

function CameraPresetRig({ controlsRef, command }) {
  const { camera } = useThree();
  useEffect(() => {
    const pos = command?.preset ? VIEW_PRESETS[command.preset] : null;
    if (!pos) return;
    camera.position.set(pos[0], pos[1], pos[2]);
    const controls = controlsRef.current;
    if (controls) {
      controls.target.set(0, 0, 0);
      controls.update();
    } else {
      camera.lookAt(0, 0, 0);
    }
  }, [command, camera, controlsRef]);
  return null;
}

function BrainMesh({
  brain,
  activation,
  progressRef,
  pickingEnabled,
  networkGroups,
  canvasGesture,
  isolatedLabelId,
  onPick,
  onClear,
  onIsolate,
  onExitIsolate,
  onRecolorPass,
}) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const positions = new Float32Array(brain.positions);
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    if (brain.indices?.length) {
      g.setIndex(new THREE.BufferAttribute(new Uint32Array(brain.indices), 1));
    }
    const colors = new Float32Array(brain.vertexCount * 3);
    for (let v = 0; v < brain.vertexCount; v++) {
      const li = 140 * 3;
      colors[v * 3] = turboLUT[li] / 255;
      colors[v * 3 + 1] = turboLUT[li + 1] / 255;
      colors[v * 3 + 2] = turboLUT[li + 2] / 255;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.computeVertexNormals();
    g.center();
    g.computeBoundingSphere();
    const r = g.boundingSphere?.radius || 1;
    const s = FIT_RADIUS / r;
    g.scale(s, s, s);
    g.computeBoundingSphere();
    return g;
  }, [brain]);

  const actRef = useRef(activation);
  const lastFrame = useRef(-1);
  const lastHover = useRef({ x: -Infinity, y: -Infinity, at: -Infinity });
  const pointerDown = useRef(null);
  const lastTapPick = useRef(null);
  const longPressTimer = useRef(null);
  const lastSelectAt = useRef(0);
  const previousIsolation = useRef(null);
  const isolatedRef = useRef(isolatedLabelId);
  const isolatedIndicesRef = useRef(null);

  useEffect(() => {
    actRef.current = activation;
  }, [activation]);

  useEffect(() => {
    isolatedRef.current = isolatedLabelId;
    isolatedIndicesRef.current =
      isolatedLabelId != null ? networkGroups.byLabel.get(isolatedLabelId) || null : null;
  }, [isolatedLabelId, networkGroups]);

  // Activation load / reel change: paint current frame, preserving isolate mask if active.
  useEffect(() => {
    if (!activation) return;
    const colors = geometry.attributes.color.array;
    const frame = Math.min(
      activation.frames - 1,
      Math.max(0, Math.floor((progressRef?.current ?? 0) * activation.frames)),
    );
    const indices = isolatedIndicesRef.current;
    if (indices) {
      applyIsolateMask(colors, activation, frame, activation.vertexCount, indices);
    } else {
      paintFrame(colors, activation.data, frame, activation.vertexCount);
    }
    lastFrame.current = frame;
    geometry.attributes.color.needsUpdate = true;
  }, [activation, geometry, progressRef]);

  // Mask pass only: enter / exit / switch isolated network — not playback ticks.
  useEffect(() => {
    if (previousIsolation.current === isolatedLabelId) return;
    previousIsolation.current = isolatedLabelId;
    const act = actRef.current;
    if (!act) return;
    const frame = Math.min(
      act.frames - 1,
      Math.max(0, Math.floor((progressRef?.current ?? 0) * act.frames)),
    );
    const colors = geometry.attributes.color.array;
    const isolatedIndices = networkGroups.byLabel.get(isolatedLabelId);
    if (isolatedIndices) {
      applyIsolateMask(colors, act, frame, act.vertexCount, isolatedIndices);
    } else {
      paintFrame(colors, act.data, frame, act.vertexCount);
    }
    lastFrame.current = frame;
    geometry.attributes.color.needsUpdate = true;
    onRecolorPass();
  }, [geometry, isolatedLabelId, networkGroups, onRecolorPass, progressRef]);

  useEffect(
    () => () => {
      clearTimeout(longPressTimer.current);
    },
    [],
  );

  useEffect(() => {
    const gesture = canvasGesture.current;
    gesture.cancelTimers = () => {
      clearLongPress();
    };
    return () => {
      gesture.cancelTimers = null;
    };
  }, [canvasGesture]);

  // Color pass: every activation-frame change, scoped to isolated set when isolating.
  useFrame(() => {
    const act = actRef.current;
    if (!act) return;
    const prog = progressRef?.current ?? 0;
    const frame = Math.min(act.frames - 1, Math.max(0, Math.floor(prog * act.frames)));
    if (frame === lastFrame.current) return;
    lastFrame.current = frame;
    const colors = geometry.attributes.color.array;
    const indices = isolatedIndicesRef.current;
    if (indices) {
      paintIsolatedColors(colors, act, frame, indices);
    } else {
      paintFrame(colors, act.data, frame, act.vertexCount);
    }
    geometry.attributes.color.needsUpdate = true;
  });

  function getPick(event, pinned = false) {
    if (!pickingEnabled) return null;
    const vertexIndex = nearestFaceVertex(event, geometry);
    if (vertexIndex == null) return null;
    const labelId = brain.atlas.labels[vertexIndex] || 0;
    const networkName = brain.atlas.networkNames[String(labelId)];
    if (!labelId || !networkName) return null;
    return { labelId, networkName, vertexIndex, pinned };
  }

  function resolvePick(event, pinned) {
    const pick = getPick(event, pinned);
    if (!pick) {
      if (pinned) {
        onExitIsolate();
        onClear();
      } else {
        onClear({ preservePinned: true });
      }
      return null;
    }
    onPick(pick);
    return pick;
  }

  function clearLongPress() {
    clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  }

  function commitNetworkTap(pick) {
    if (!pick) return;
    const now = performance.now();
    if (now - lastSelectAt.current < SELECT_DEBOUNCE_MS) return;
    lastSelectAt.current = now;
    onExitIsolate();
    onPick({ ...pick, pinned: true });
  }

  function handlePointerMove(event) {
    const { x, y, pointerType } = eventCoords(event);
    if (!pickingEnabled) return;
    if (pointerDown.current) {
      const dist = Math.hypot(x - pointerDown.current.x, y - pointerDown.current.y);
      // Isolate arms only while nearly stationary; cancel before full tap-slop.
      if (dist >= LONG_PRESS_CANCEL_PX) {
        clearLongPress();
      }
      if (dist > tapSlopFor(pointerDown.current.pointerType)) {
        pointerDown.current.dragged = true;
        clearLongPress();
      }
      return;
    }
    if (canvasGesture.current.active && canvasGesture.current.moved) {
      clearLongPress();
      return;
    }
    if (isDragGesture(canvasGesture, pointerType)) return;
    if (isTouchPointer(pointerType)) return;
    const now = performance.now();
    const previous = lastHover.current;
    const moved = Math.hypot(x - previous.x, y - previous.y);
    if (now - previous.at < HOVER_INTERVAL_MS && moved < HOVER_MOVE_PX) return;
    lastHover.current = { x, y, at: now };
    resolvePick(event, false);
  }

  function handlePointerDown(event) {
    if (!pickingEnabled) return;
    clearLongPress();
    const { x, y, pointerType, isPrimary } = eventCoords(event);
    // Pick on down: touch + OrbitControls often miss on pointerup/click.
    const pick = getPick(event, true);
    lastTapPick.current = pick;
    pointerDown.current = {
      x,
      y,
      pointerType,
      isPrimary,
      at: performance.now(),
      pick,
      dragged: false,
      longPressFired: false,
    };
    if (isTouchPointer(pointerType) && isPrimary && pick) {
      longPressTimer.current = window.setTimeout(() => {
        if (!pointerDown.current || pointerDown.current.dragged) return;
        if (canvasGesture.current.moved) return;
        pointerDown.current.longPressFired = true;
        canvasGesture.current.longPressFired = true;
        onIsolate({ ...pick, pinned: true });
      }, LONG_PRESS_MS);
    }
  }

  function handlePointerUp(event) {
    const started = pointerDown.current;
    pointerDown.current = null;
    clearLongPress();
    if (!pickingEnabled || !started || started.longPressFired) return;
    const { x, y } = eventCoords(event);
    const elapsed = performance.now() - started.at;
    // Touch: long-press is the upper bound (avoid a dead zone vs LONG_PRESS_MS).
    // Mouse/pen: keep the shorter tap duration window.
    const tapExpired = isTouchPointer(started.pointerType)
      ? elapsed >= LONG_PRESS_MS
      : elapsed > TAP_MAX_MS;
    if (
      started.dragged ||
      isDragGesture(canvasGesture, started.pointerType, started, x, y) ||
      tapExpired
    ) {
      return;
    }
    if (started.pick) {
      commitNetworkTap(started.pick);
    }
  }

  function handleClick(event) {
    if (!pickingEnabled) return;
    const { pointerType } = eventCoords(event);
    if (canvasGesture.current.longPressFired) {
      canvasGesture.current.longPressFired = false;
      return;
    }
    if (isDragGesture(canvasGesture, pointerType)) return;
    const pick = getPick(event, true) || lastTapPick.current;
    if (!pick) return;
    commitNetworkTap(pick);
  }

  return (
    <mesh
      geometry={geometry}
      rotation={[-Math.PI / 2.2, 0.2, 0.05]}
      onPointerMove={handlePointerMove}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onClick={handleClick}
      onDoubleClick={(event) => {
        const { pointerType } = eventCoords(event);
        if (isTouchPointer(pointerType)) return;
        if (isDragGesture(canvasGesture, pointerType)) return;
        const pick = getPick(event, true) || lastTapPick.current;
        if (pick) onIsolate({ ...pick, pinned: true });
      }}
      onPointerOut={(event) => {
        clearLongPress();
        if (!isTouchPointer(eventCoords(event).pointerType)) {
          onClear({ preservePinned: true });
        }
      }}
    >
      <meshStandardMaterial
        vertexColors
        roughness={0.45}
        metalness={0.12}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

export default function BrainViewer({
  brain,
  activation,
  progressRef,
  videoId,
  timeSec = 0,
  onNetworkChange,
  compact = false,
  masterCamera = null,
}) {
  const [hover, setHover] = useState(null);
  const [selected, setSelected] = useState(null);
  const [isolatedLabelId, setIsolatedLabelId] = useState(null);
  const [recolorPasses, setRecolorPasses] = useState(0);
  const [spinEnabled, setSpinEnabled] = useState(false);
  const [touchUi, setTouchUi] = useState(false);
  const [viewCommand, setViewCommand] = useState(null);
  const [activePreset, setActivePreset] = useState(null);
  const controlsRef = useRef(null);
  const viewNonce = useRef(0);
  const canvasGesture = useRef({
    active: false,
    moved: false,
    x: 0,
    y: 0,
    at: 0,
    longPressFired: false,
    dragGuardUntil: 0,
    cancelTimers: null,
  });
  const suppressClearUntil = useRef(0);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia('(pointer: coarse), (hover: none)');
    const sync = () => setTouchUi(mq.matches);
    sync();
    mq.addEventListener?.('change', sync);
    return () => mq.removeEventListener?.('change', sync);
  }, []);
  const pickingEnabled = Boolean(
    brain &&
      !brain.synthetic &&
      brain.atlas?.labels?.length === brain.vertexCount &&
      brain.atlas?.networkNames,
  );
  const networkGroups = useMemo(
    () => buildNetworkGroups(brain?.atlas?.labels || new Uint8Array()),
    [brain],
  );

  useEffect(() => {
    setHover(null);
    setSelected(null);
    setIsolatedLabelId(null);
  }, [videoId]);

  function applyPreset(name) {
    if (!VIEW_PRESETS[name]) return;
    setSpinEnabled(false);
    setActivePreset(name);
    viewNonce.current += 1;
    setViewCommand({ preset: name, nonce: viewNonce.current });
  }

  useEffect(() => {
    if (!masterCamera?.seq) return;
    if (masterCamera.spin) {
      setSpinEnabled(true);
      setActivePreset(null);
      return;
    }
    if (masterCamera.preset) applyPreset(masterCamera.preset);
  }, [masterCamera]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key !== 'Escape') return;
      setIsolatedLabelId(null);
      setHover(null);
      setSelected(null);
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const isolatedIndices = networkGroups.byLabel.get(isolatedLabelId);
  const isolatedNetworkName = brain?.atlas?.networkNames?.[String(isolatedLabelId)];
  const isolateInfo =
    isolatedNetworkName && isolatedIndices
      ? {
          networkName: isolatedNetworkName,
          vertexCount: isolatedIndices.length,
          cortexPercent:
            networkGroups.cortexVertexCount > 0
              ? Math.round((isolatedIndices.length / networkGroups.cortexVertexCount) * 100)
              : 0,
        }
      : null;

  const selectedNetworkName = selected?.networkName || isolateInfo?.networkName || null;
  const activeNetworkName = hover?.networkName || selectedNetworkName || null;

  useEffect(() => {
    onNetworkChange?.({
      hover: hover?.networkName ?? null,
      selected: selectedNetworkName,
    });
  }, [hover, selectedNetworkName, onNetworkChange]);

  function handlePick(pick) {
    if (pick?.pinned) {
      suppressClearUntil.current = performance.now() + PIN_SUPPRESS_MS;
      setHover(null);
      setSelected({ ...pick, pinned: true });
      return;
    }
    setHover(pick);
  }

  function handleClear({ preservePinned = false } = {}) {
    setHover(null);
    if (!preservePinned) {
      setSelected(null);
    }
  }

  function exitIsolate() {
    setIsolatedLabelId(null);
  }

  function clearAllSelection() {
    exitIsolate();
    handleClear();
  }

  const currentTime = Math.max(0, Number(timeSec) || 0);

  const handleIsolate = (pick) => {
    suppressClearUntil.current = performance.now() + PIN_SUPPRESS_MS;
    setHover(null);
    setSelected({ ...pick, pinned: true });
    setIsolatedLabelId((current) => (current === pick.labelId ? null : pick.labelId));
  };

  const handleRecolorPass = () => {
    setRecolorPasses((count) => count + 1);
  };

  const clearFromCanvas = () => {
    if (
      canvasGesture.current.moved ||
      performance.now() < canvasGesture.current.dragGuardUntil ||
      performance.now() < suppressClearUntil.current
    ) {
      return;
    }
    clearAllSelection();
  };

  if (!brain) {
    return (
      <div className="sphere-loading" aria-hidden>
        <div className="sphere-loading-box" />
      </div>
    );
  }

  const viewControls = (
    <>
      <div
        className="brain-view-group"
        role="group"
        aria-label="Lock camera to a fixed angle"
      >
        {VIEW_ORDER.map((name) => (
          <button
            key={name}
            type="button"
            className={`brain-view-btn${activePreset === name ? ' is-active' : ''}`}
            aria-pressed={activePreset === name}
            title={`Lock view: ${name}`}
            onClick={() => applyPreset(name)}
          >
            {name[0]}
          </button>
        ))}
      </div>
      <button
        type="button"
        className={`brain-spin-toggle${spinEnabled ? ' is-active' : ''}`}
        aria-pressed={spinEnabled}
        title={
          spinEnabled
            ? 'Spinning. Drag to turn; spin resumes after you release.'
            : 'Turn on slow auto-spin. Drag anytime to steer the view.'
        }
        onClick={() =>
          setSpinEnabled((on) => {
            if (!on) setActivePreset(null);
            return !on;
          })
        }
      >
        spin
      </button>
      <span className="brain-viewer-time">t≈{currentTime.toFixed(1)}s</span>
    </>
  );

  return (
    <div className={`brain-viewer-shell${compact ? ' is-compact' : ''}`}>
      <div className="brain-viewer-header">
        {!compact && (
          <ReelId id={videoId} variant="stage" className="brain-viewer-reel" />
        )}
        <div className="brain-header-legend" aria-label="Predicted activation low to high">
          <span className="brain-legend-low">low</span>
          <span
            className="brain-activation-legend-scale"
            style={{ background: TURBO_LEGEND_BACKGROUND }}
          />
          <span className="brain-legend-high">high</span>
        </div>
      </div>
      <div
        className={`brain-canvas-host${pickingEnabled ? ' is-atlas-pickable' : ''}`}
        data-atlas-picking={pickingEnabled ? 'enabled' : 'disabled'}
        data-isolated-network={isolateInfo?.networkName || ''}
        data-recolor-passes={recolorPasses}
        onPointerDownCapture={(event) => {
          const { x, y } = eventCoords(event);
          canvasGesture.current.active = true;
          canvasGesture.current.moved = false;
          canvasGesture.current.longPressFired = false;
          canvasGesture.current.x = x;
          canvasGesture.current.y = y;
          canvasGesture.current.at = performance.now();
          canvasGesture.current.cancelTimers?.();
        }}
        onPointerMoveCapture={(event) => {
          if (!canvasGesture.current.active) return;
          const { x, y, pointerType } = eventCoords(event);
          const dist = Math.hypot(x - canvasGesture.current.x, y - canvasGesture.current.y);
          if (dist >= LONG_PRESS_CANCEL_PX) {
            canvasGesture.current.cancelTimers?.();
          }
          if (dist > tapSlopFor(pointerType)) {
            canvasGesture.current.moved = true;
            canvasGesture.current.cancelTimers?.();
          }
        }}
        onPointerUpCapture={() => {
          if (canvasGesture.current.moved) {
            canvasGesture.current.dragGuardUntil = performance.now() + DRAG_GUARD_MS;
          }
          window.setTimeout(() => {
            canvasGesture.current.active = false;
            canvasGesture.current.moved = false;
          }, 0);
        }}
        onPointerCancelCapture={() => {
          if (canvasGesture.current.moved) {
            canvasGesture.current.dragGuardUntil = performance.now() + DRAG_GUARD_MS;
          }
          canvasGesture.current.active = false;
          canvasGesture.current.moved = false;
          canvasGesture.current.cancelTimers?.();
        }}
      >
        <Canvas
          camera={{ position: [0, 0.35, 5.8], fov: 38 }}
          dpr={[1, 2]}
          gl={{ antialias: true, alpha: false, preserveDrawingBuffer: true }}
          style={{ width: '100%', height: '100%', display: 'block' }}
          role="application"
          aria-label={
            touchUi
              ? 'Brain viewer. Tap to select a network, press and hold to isolate, drag to rotate, tap empty to clear.'
              : 'Brain viewer. Click to select a network, double-click to isolate, drag to rotate, click empty or press Escape to clear.'
          }
          tabIndex={pickingEnabled ? 0 : -1}
          onPointerMissed={clearFromCanvas}
        >
          <color attach="background" args={['#F5F5F5']} />
          <ambientLight intensity={0.85} />
          <directionalLight position={[4, 6, 5]} intensity={1.15} />
          <directionalLight position={[-5, -1, -3]} intensity={0.4} />
          <hemisphereLight args={['#ffffff', '#dddddd', 0.4]} />
          <BrainMesh
            brain={brain}
            activation={activation}
            progressRef={progressRef}
            pickingEnabled={pickingEnabled}
            networkGroups={networkGroups}
            canvasGesture={canvasGesture}
            isolatedLabelId={isolatedLabelId}
            onPick={handlePick}
            onClear={handleClear}
            onIsolate={handleIsolate}
            onExitIsolate={exitIsolate}
            onRecolorPass={handleRecolorPass}
          />
          <CameraPresetRig controlsRef={controlsRef} command={viewCommand} />
          <OrbitControls
            ref={controlsRef}
            enablePan={false}
            enableZoom
            minDistance={3}
            maxDistance={9}
            target={[0, 0, 0]}
            onStart={() => setActivePreset(null)}
            autoRotate={spinEnabled}
            autoRotateSpeed={0.7}
            enableDamping
            dampingFactor={0.08}
            rotateSpeed={touchUi ? 0.85 : 1}
            touches={{
              ONE: THREE.TOUCH.ROTATE,
              TWO: THREE.TOUCH.DOLLY_PAN,
            }}
          />
        </Canvas>

        {pickingEnabled && touchUi && !activeNetworkName && (
          <div className="brain-gesture-hint" aria-hidden>
            tap select · hold isolate · drag turn
          </div>
        )}

        {activeNetworkName && (
          <div
            className={`brain-region-readout${compact ? ' is-compact' : ''}${
              isolateInfo ? ' is-isolated' : ''
            }`}
            role="status"
            aria-live="polite"
          >
            <div className="brain-region-readout-top">
              <div className="brain-region-value">{activeNetworkName}</div>
              <button
                type="button"
                className="brain-region-clear"
                onClick={(event) => {
                  event.stopPropagation();
                  clearAllSelection();
                }}
                aria-label="Clear network selection"
                title="Clear"
              >
                ×
              </button>
            </div>
            {!compact && (
              <div className="brain-region-caption">
                {isolateInfo
                  ? 'isolated'
                  : touchUi
                    ? 'selected · hold to isolate'
                    : 'selected · double-click to isolate'}
              </div>
            )}
            {isolateInfo && (
              <div className="brain-region-extent">
                {compact
                  ? 'isolated'
                  : `${isolateInfo.vertexCount.toLocaleString()} vertices · ~${
                      isolateInfo.cortexPercent
                    }% of cortex shown`}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="brain-view-toolbar">{viewControls}</div>
    </div>
  );
}
