import { useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { turboLUT } from '../lib/colormap';

/** Target bounding-sphere radius so MRI-scale meshes fit the camera. */
const FIT_RADIUS = 2.4;

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

function BrainMesh({ brain, activation, progressRef }) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    // Clone buffers — compare mode mounts multiple viewers sharing one brain object.
    const positions = new Float32Array(brain.positions);
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    if (brain.indices?.length) {
      g.setIndex(new THREE.BufferAttribute(new Uint32Array(brain.indices), 1));
    }
    const colors = new Float32Array(brain.vertexCount * 3);
    // Mid-turbo seed so the mesh is vivid before the first animation tick.
    for (let v = 0; v < brain.vertexCount; v++) {
      const li = 140 * 3;
      colors[v * 3] = turboLUT[li] / 255;
      colors[v * 3 + 1] = turboLUT[li + 1] / 255;
      colors[v * 3 + 2] = turboLUT[li + 2] / 255;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.computeVertexNormals();
    // Real fsaverage coords are ~±100 units; camera sits at z≈5.8.
    // Without normalize, the camera is inside the mesh → flat color fill.
    g.center();
    g.computeBoundingSphere();
    const r = g.boundingSphere?.radius || 1;
    const s = FIT_RADIUS / r;
    g.scale(s, s, s);
    g.computeBoundingSphere();
    return g;
  }, [brain]);

  // Do NOT dispose in an effect cleanup: React Strict Mode remounts dispose the
  // live geometry and WebGL then crashes on array.byteLength === undefined.

  const actRef = useRef(activation);
  useEffect(() => {
    actRef.current = activation;
  }, [activation]);

  // Paint frame 0 as soon as activation arrives.
  useEffect(() => {
    if (!activation) return;
    const colors = geometry.attributes.color.array;
    paintFrame(colors, activation.data, 0, activation.vertexCount);
    geometry.attributes.color.needsUpdate = true;
  }, [activation, geometry]);

  const lastFrame = useRef(-1);

  useFrame(() => {
    const act = actRef.current;
    if (!act) return;
    const prog = progressRef?.current ?? 0;
    const frame = Math.min(act.frames - 1, Math.max(0, Math.floor(prog * act.frames)));
    if (frame === lastFrame.current) return;
    lastFrame.current = frame;
    paintFrame(geometry.attributes.color.array, act.data, frame, act.vertexCount);
    geometry.attributes.color.needsUpdate = true;
  });

  return (
    <mesh geometry={geometry} rotation={[-Math.PI / 2.2, 0.2, 0.05]}>
      <meshStandardMaterial
        vertexColors
        roughness={0.45}
        metalness={0.12}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

export default function BrainViewer({ brain, activation, progressRef }) {
  if (!brain) {
    return (
      <div className="sphere-loading" aria-hidden>
        <div className="sphere-loading-box" />
      </div>
    );
  }

  return (
    <div className="brain-canvas-host">
      <Canvas
        camera={{ position: [0, 0.35, 5.8], fov: 38 }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: false, preserveDrawingBuffer: true }}
        style={{ width: '100%', height: '100%', display: 'block' }}
      >
        <color attach="background" args={['#F5F5F5']} />
        <ambientLight intensity={0.85} />
        <directionalLight position={[4, 6, 5]} intensity={1.15} />
        <directionalLight position={[-5, -1, -3]} intensity={0.4} />
        <hemisphereLight args={['#ffffff', '#dddddd', 0.4]} />
        <BrainMesh brain={brain} activation={activation} progressRef={progressRef} />
        <OrbitControls
          enablePan={false}
          minDistance={3}
          maxDistance={9}
          autoRotate
          autoRotateSpeed={0.7}
          target={[0, 0, 0]}
        />
      </Canvas>
    </div>
  );
}
