'use client';

import { useRef, useState, useEffect, useMemo } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

const MODEL_URL = '/models/mahjong-points.bin';
// Optional per-point photoreal colours (written by the PLY/3DGS path). Absent
// for the CAD STL, in which case the model gets a brand-colour height gradient.
const MODEL_COLORS_URL = '/models/mahjong-points-colors.bin';

// Scroll timeline (in smoothed progress 0..1):
//   0.00-0.18  text flies in and assembles
//   0.18-0.30  hold text (readable)
//   0.30-0.55  morph text -> 3D model point cloud (+ 3D rotation ramps in)
//   0.55-0.75  hold model (rotating)
//   0.75-1.00  tear apart / explode
const ASSEMBLE_END = 0.18;
const MORPH_START = 0.3;
const MORPH_END = 0.55;
const BLAST_START = 0.75;

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
function clamp01(t: number) {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}
function easeOutCubic(t: number) {
  return 1 - (1 - t) * (1 - t) * (1 - t);
}
function easeInCubic(t: number) {
  return t * t * t;
}
function smoothstep(t: number) {
  return t * t * (3 - 2 * t);
}

// Rasterize the title to an offscreen canvas and return its filled pixels.
function sampleTextCoords(text: string) {
  const cw = 1200;
  const ch = 600;
  if (typeof document === 'undefined') return { coords: [] as number[], cw, ch };
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { coords: [], cw, ch };

  const words = text.trim().split(/\s+/);
  let lines: string[];
  if (words.length <= 1) {
    lines = [text.trim()];
  } else {
    let best = [text.trim()];
    let bestMax = Infinity;
    for (let i = 1; i < words.length; i++) {
      const l1 = words.slice(0, i).join(' ');
      const l2 = words.slice(i).join(' ');
      const m = Math.max(l1.length, l2.length);
      if (m < bestMax) {
        bestMax = m;
        best = [l1, l2];
      }
    }
    lines = best;
  }

  const font = (s: number) => `bold ${s}px "Helvetica Neue", Arial, sans-serif`;
  let fontSize = 400;
  ctx.font = font(fontSize);
  let maxW = 1;
  for (const ln of lines) maxW = Math.max(maxW, ctx.measureText(ln).width);
  fontSize = Math.max(
    40,
    Math.floor(
      fontSize *
        Math.min((cw * 0.88) / maxW, (ch * 0.72) / (lines.length * fontSize * 1.08))
    )
  );

  ctx.font = font(fontSize);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lineH = fontSize * 1.08;
  const startY = ch / 2 - ((lines.length - 1) * lineH) / 2;
  lines.forEach((ln, i) => ctx.fillText(ln, cw / 2, startY + i * lineH));

  const img = ctx.getImageData(0, 0, cw, ch).data;
  const step = 4;
  const coords: number[] = [];
  for (let y = 0; y < ch; y += step) {
    for (let x = 0; x < cw; x += step) {
      if (img[(y * cw + x) * 4 + 3] > 128) coords.push(x, y);
    }
  }
  return { coords, cw, ch };
}

type MorphData = {
  count: number;
  positions: Float32Array; // live position buffer (starts scattered)
  colors: Float32Array; // live colour buffer (starts as text palette)
  textColors: Float32Array;
  modelColors: Float32Array;
  textHome: Float32Array;
  modelHome: Float32Array;
  scatterA: Float32Array;
  scatterB: Float32Array;
  delayForm: Float32Array;
  delayMorph: Float32Array;
  delayBlast: Float32Array;
};

// Build one particle system whose members each know three "home" poses:
// the text layout, the 3D model surface, plus fly-in and explosion targets.
function buildMorphData(
  text: string,
  model: Float32Array | null,
  modelColorData: Float32Array | null
): MorphData {
  const { coords, cw, ch } = sampleTextCoords(text);
  const textCount = Math.max(1, coords.length / 2);

  const hasModel = !!model && model.length >= 3;
  const count = hasModel ? model!.length / 3 : textCount;
  const hasColor = !!modelColorData && modelColorData.length === count * 3;

  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const textColors = new Float32Array(count * 3);
  const modelColors = new Float32Array(count * 3);
  const textHome = new Float32Array(count * 3);
  const modelHome = new Float32Array(count * 3);
  const scatterA = new Float32Array(count * 3);
  const scatterB = new Float32Array(count * 3);
  const delayForm = new Float32Array(count);
  const delayMorph = new Float32Array(count);
  const delayBlast = new Float32Array(count);

  const worldW = 9;
  const worldH = (worldW * ch) / cw; // keep text aspect

  // model vertical range for a gradient colour
  let minY = Infinity;
  let maxY = -Infinity;
  if (hasModel) {
    for (let k = 0; k < count; k++) {
      const y = model![k * 3 + 1];
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const cAccent = new THREE.Color('#e94560');
  const cTeal = new THREE.Color('#4ecdc4');
  const cWhite = new THREE.Color('#fff2d8');
  const tmp = new THREE.Color();

  for (let k = 0; k < count; k++) {
    const i3 = k * 3;

    // text home: spread the N particles evenly across the text pixels
    const ti = Math.floor((k * textCount) / count) % textCount;
    const tx = coords[ti * 2] ?? cw / 2;
    const ty = coords[ti * 2 + 1] ?? ch / 2;
    textHome[i3] = (tx / cw - 0.5) * worldW;
    textHome[i3 + 1] = -(ty / ch - 0.5) * worldH;
    textHome[i3 + 2] = (Math.random() - 0.5) * 0.4;

    // model home
    if (hasModel) {
      modelHome[i3] = model![i3];
      modelHome[i3 + 1] = model![i3 + 1];
      modelHome[i3 + 2] = model![i3 + 2];
    } else {
      modelHome[i3] = textHome[i3];
      modelHome[i3 + 1] = textHome[i3 + 1];
      modelHome[i3 + 2] = textHome[i3 + 2];
    }

    // fly-in origin: point on a large surrounding sphere
    const rA = 9 + Math.random() * 9;
    const thA = Math.random() * Math.PI * 2;
    const phA = Math.acos(2 * Math.random() - 1);
    scatterA[i3] = Math.sin(phA) * Math.cos(thA) * rA;
    scatterA[i3 + 1] = Math.sin(phA) * Math.sin(thA) * rA * 0.7;
    scatterA[i3 + 2] = Math.cos(phA) * rA - 4;

    // explosion target: outward from the model centre + depth spread
    const mx = modelHome[i3];
    const my = modelHome[i3 + 1];
    const ang = Math.atan2(my, mx) + (Math.random() - 0.5) * 0.8;
    const dist = 7 + Math.random() * 12;
    scatterB[i3] = mx + Math.cos(ang) * dist;
    scatterB[i3 + 1] = my + Math.sin(ang) * dist + (Math.random() - 0.3) * 3;
    scatterB[i3 + 2] = modelHome[i3 + 2] + (Math.random() - 0.5) * 14;

    // start at the fly-in origin
    positions[i3] = scatterA[i3];
    positions[i3 + 1] = scatterA[i3 + 1];
    positions[i3 + 2] = scatterA[i3 + 2];

    // text colour: brand palette
    const rc = Math.random();
    const tc = rc < 0.7 ? cAccent : rc < 0.92 ? cTeal : cWhite;
    textColors[i3] = tc.r;
    textColors[i3 + 1] = tc.g;
    textColors[i3 + 2] = tc.b;

    // model colour: photoreal from the splat if present, else a brand height gradient
    if (hasColor) {
      modelColors[i3] = modelColorData![i3];
      modelColors[i3 + 1] = modelColorData![i3 + 1];
      modelColors[i3 + 2] = modelColorData![i3 + 2];
    } else if (hasModel && maxY > minY) {
      tmp.copy(cAccent).lerp(cTeal, (modelHome[i3 + 1] - minY) / (maxY - minY));
      if (Math.random() < 0.1) tmp.copy(cWhite);
      modelColors[i3] = tmp.r;
      modelColors[i3 + 1] = tmp.g;
      modelColors[i3 + 2] = tmp.b;
    } else {
      modelColors[i3] = tc.r;
      modelColors[i3 + 1] = tc.g;
      modelColors[i3 + 2] = tc.b;
    }

    // live colour buffer starts on the text palette
    colors[i3] = textColors[i3];
    colors[i3 + 1] = textColors[i3 + 1];
    colors[i3 + 2] = textColors[i3 + 2];

    // staggers: assemble left->right, morph + blast ripple randomly
    const nx = textHome[i3] / worldW + 0.5;
    delayForm[k] = Math.min(0.08, Math.max(0, nx * 0.07 + Math.random() * 0.02));
    delayMorph[k] = Math.random() * 0.08;
    delayBlast[k] = Math.random() * 0.12;
  }

  return {
    count,
    positions,
    colors,
    textColors,
    modelColors,
    textHome,
    modelHome,
    scatterA,
    scatterB,
    delayForm,
    delayMorph,
    delayBlast,
  };
}

function MorphParticles({ text, progress }: { text: string; progress: number }) {
  const groupRef = useRef<THREE.Group>(null);
  const pointsRef = useRef<THREE.Points>(null);
  const smooth = useRef(0);
  const [model, setModel] = useState<Float32Array | null>(null);
  const [modelColors, setModelColors] = useState<Float32Array | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(MODEL_URL)
      .then((r) => r.arrayBuffer())
      .then((ab) => {
        if (!cancelled) setModel(new Float32Array(ab));
      })
      .catch(() => {});
    fetch(MODEL_COLORS_URL)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((ab) => {
        if (!cancelled && ab) setModelColors(new Float32Array(ab));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const data = useMemo(
    () => buildMorphData(text, model, modelColors),
    [text, model, modelColors]
  );

  useFrame(() => {
    const pts = pointsRef.current;
    const grp = groupRef.current;
    if (!pts || !grp) return;

    smooth.current = lerp(smooth.current, progress, 0.08);
    const p = smooth.current;

    const posAttr = pts.geometry.attributes.position as THREE.BufferAttribute;
    const colAttr = pts.geometry.attributes.color as THREE.BufferAttribute;
    const arr = posAttr.array as Float32Array;
    const col = colAttr.array as Float32Array;
    const n = Math.min(data.count, arr.length / 3);

    for (let k = 0; k < n; k++) {
      const i3 = k * 3;

      const a = easeOutCubic(clamp01((p - data.delayForm[k]) / ASSEMBLE_END));
      const m = smoothstep(
        clamp01((p - MORPH_START - data.delayMorph[k]) / (MORPH_END - MORPH_START))
      );
      const b = easeInCubic(
        clamp01((p - BLAST_START - data.delayBlast[k]) / (1 - BLAST_START))
      );

      for (let j = 0; j < 3; j++) {
        const base = lerp(data.scatterA[i3 + j], data.textHome[i3 + j], a);
        const formed = lerp(base, data.modelHome[i3 + j], m);
        arr[i3 + j] = lerp(formed, data.scatterB[i3 + j], b);
        // colour morphs from the brand palette to the model colour
        col[i3 + j] = lerp(data.textColors[i3 + j], data.modelColors[i3 + j], m);
      }
    }
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;

    // Scroll-driven 3D rotation (deterministic + reversible): no rotation while
    // the word is readable, a gentle turn through the morph, then a sweep as the
    // model holds and explodes. Must be a pure function of progress — an
    // accumulator left the word mirrored after scrolling back up.
    const rf = smoothstep(clamp01((p - MORPH_START) / (MORPH_END - MORPH_START)));
    const spinModel = clamp01((p - MORPH_END) / (1 - MORPH_END));
    grp.rotation.y = rf * 0.5 + spinModel * Math.PI;
    grp.rotation.x = -0.35 * rf;
  });

  return (
    <group ref={groupRef}>
      <points ref={pointsRef} key={data.count}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[data.positions, 3]} />
          <bufferAttribute attach="attributes-color" args={[data.colors, 3]} />
        </bufferGeometry>
        <pointsMaterial
          size={0.04}
          vertexColors
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          sizeAttenuation
        />
      </points>
    </group>
  );
}

// Front-facing camera: gentle mid-scroll dolly + subtle mouse parallax.
function CameraRig({ progress }: { progress: number }) {
  const { camera } = useThree();
  const smooth = useRef(0);

  useFrame((state) => {
    smooth.current = lerp(smooth.current, progress, 0.08);
    const zoom = Math.sin(clamp01(smooth.current) * Math.PI); // 0 -> 1 -> 0
    const targetZ = 10 - zoom * 2.5;

    camera.position.x += (state.pointer.x * 0.8 - camera.position.x) * 0.05;
    camera.position.y += (state.pointer.y * 0.5 - camera.position.y) * 0.05;
    camera.position.z += (targetZ - camera.position.z) * 0.05;
    camera.lookAt(0, 0, 0);
  });

  return null;
}

function BackgroundParticles({ progress }: { progress: number }) {
  const pointsRef = useRef<THREE.Points>(null);

  const positions = useMemo(() => {
    const arr = new Float32Array(200 * 3);
    for (let i = 0; i < 200; i++) {
      arr[i * 3] = (Math.random() - 0.5) * 16;
      arr[i * 3 + 1] = (Math.random() - 0.5) * 16;
      arr[i * 3 + 2] = (Math.random() - 0.5) * 16 - 4;
    }
    return arr;
  }, []);

  useFrame(() => {
    if (pointsRef.current) {
      pointsRef.current.rotation.y += 0.0004;
      const mat = pointsRef.current.material as THREE.PointsMaterial;
      mat.opacity = lerp(0.12, 0.35, progress);
    }
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial size={0.025} color="#e94560" transparent opacity={0.12} sizeAttenuation />
    </points>
  );
}

function Scene({ progress, text }: { progress: number; text: string }) {
  return (
    <>
      <MorphParticles text={text} progress={progress} />
      <BackgroundParticles progress={progress} />
      <CameraRig progress={progress} />
    </>
  );
}

export default function ScrollScene({
  hero,
  stages,
}: {
  hero: { title: string; subtitle: string; scrollHint: string };
  stages: { title: string; text: string }[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const handleScroll = () => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const scrollHeight = containerRef.current.offsetHeight - window.innerHeight;
      const scrolled = -rect.top;
      const p = Math.max(0, Math.min(1, scrolled / scrollHeight));
      setProgress(p);
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const heroOpacity = clamp01(1 - progress * 4.5); // subtitle/hint fade early
  const stageStart = 0.72;
  const stageProgress = clamp01((progress - stageStart) / (1 - stageStart));
  const currentStage = Math.min(
    Math.floor(stageProgress * stages.length),
    stages.length - 1
  );

  if (!mounted) {
    return <div className="h-[500vh] bg-gray-950" />;
  }

  return (
    <div ref={containerRef} className="relative h-[500vh] bg-gray-950">
      {/* Sticky canvas */}
      <div className="sticky top-0 h-screen w-full overflow-hidden">
        <Canvas camera={{ position: [0, 0, 10], fov: 50 }}>
          <Scene progress={progress} text={hero.title} />
        </Canvas>

        {/* Accessible heading — the particle word is not readable to screen readers */}
        <h1 className="sr-only">{hero.title}</h1>

        {/* Hero overlay — subtitle + scroll hint, fade as you scroll */}
        <div
          className="absolute inset-0 flex flex-col items-center justify-end pb-24 pointer-events-none"
          style={{ opacity: heroOpacity }}
        >
          <p className="text-xl md:text-2xl text-gray-300 mb-8 text-center px-4">
            {hero.subtitle}
          </p>
          <p className="text-sm text-gray-500 animate-bounce">
            &#8595; {hero.scrollHint}
          </p>
        </div>

        {/* Stage text overlay — appears as the model tears apart */}
        <div
          className="absolute inset-0 flex items-center pointer-events-none"
          style={{ opacity: progress > 0.7 ? 1 : 0, transition: 'opacity 0.5s' }}
        >
          <div className="max-w-7xl mx-auto px-4 w-full">
            <div className="max-w-md">
              {stages.map((stage, i) => (
                <div
                  key={i}
                  className={`absolute transition-all duration-700 ${
                    currentStage === i && stageProgress > 0
                      ? 'opacity-100 translate-y-0'
                      : currentStage > i
                        ? 'opacity-0 -translate-y-8'
                        : 'opacity-0 translate-y-8'
                  }`}
                >
                  <h3 className="text-3xl md:text-4xl font-bold text-white mb-4">
                    {stage.title}
                  </h3>
                  <p className="text-gray-400 text-lg">{stage.text}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Progress bar */}
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 w-32 h-1 bg-white/10 rounded-full overflow-hidden">
          <div
            className="h-full bg-accent rounded-full transition-all duration-100"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      </div>
    </div>
  );
}
