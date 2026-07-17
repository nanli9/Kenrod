'use client';

import { useRef, useState, useEffect, useMemo } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

// Real gaussians from a 3DGS capture: 32 bytes/splat (pos, scale, rgba, quat).
// Written by scripts/model-to-points.mjs from a .ply.
const SPLAT_URL = '/models/mahjong-points-splats.bin';
// Fallback for the CAD STL, which has no gaussian params: plain Float32 xyz.
// Those get synthesised into small isotropic gaussians + a brand height gradient
// so both sources feed the same splat renderer.
const POINTS_URL = '/models/mahjong-points.bin';

// 150k splats is a desktop budget: alpha-blended overdraw plus a per-frame depth
// sort. Small screens get a prefix of the cloud (file order is not spatially
// sorted, so a prefix is an even subset).
const MAX_SPLATS_DESKTOP = 150000;
const MAX_SPLATS_MOBILE = 40000;

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

// A model source, however it was loaded: real gaussians from a splat capture, or
// isotropic stand-ins synthesised from a bare point cloud.
type ModelSource = {
  count: number;
  pos: Float32Array; // xyz
  scale: Float32Array; // xyz, world units
  quat: Float32Array; // xyzw
  color: Float32Array; // rgb 0..1
  opacity: Float32Array;
  photoreal: boolean; // false => synthesised, use the brand gradient
};

// Decode the 32-byte .splat layout written by the PLY path.
function parseSplats(ab: ArrayBuffer, limit: number): ModelSource {
  const total = Math.floor(ab.byteLength / 32);
  const count = Math.min(total, limit);
  const f32 = new Float32Array(ab);
  const u8 = new Uint8Array(ab);
  const pos = new Float32Array(count * 3);
  const scale = new Float32Array(count * 3);
  const quat = new Float32Array(count * 4);
  const color = new Float32Array(count * 3);
  const opacity = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const f = i * 8;
    const b = i * 32;
    pos[i * 3] = f32[f];
    pos[i * 3 + 1] = f32[f + 1];
    pos[i * 3 + 2] = f32[f + 2];
    scale[i * 3] = f32[f + 3];
    scale[i * 3 + 1] = f32[f + 4];
    scale[i * 3 + 2] = f32[f + 5];
    color[i * 3] = u8[b + 24] / 255;
    color[i * 3 + 1] = u8[b + 25] / 255;
    color[i * 3 + 2] = u8[b + 26] / 255;
    opacity[i] = u8[b + 27] / 255;
    // stored wxyz, shader wants xyzw
    quat[i * 4] = (u8[b + 29] - 128) / 128;
    quat[i * 4 + 1] = (u8[b + 30] - 128) / 128;
    quat[i * 4 + 2] = (u8[b + 31] - 128) / 128;
    quat[i * 4 + 3] = (u8[b + 28] - 128) / 128;
  }
  return { count, pos, scale, quat, color, opacity, photoreal: true };
}

// A bare point cloud (STL path) has no gaussians — give every point the same
// small isotropic one so it still renders through the splat pipeline.
function synthesiseSplats(ab: ArrayBuffer, limit: number): ModelSource {
  const all = new Float32Array(ab);
  const count = Math.min(Math.floor(all.length / 3), limit);
  const pos = all.subarray(0, count * 3);
  const scale = new Float32Array(count * 3).fill(0.01);
  const quat = new Float32Array(count * 4);
  const color = new Float32Array(count * 3);
  const opacity = new Float32Array(count).fill(0.9);
  for (let i = 0; i < count; i++) quat[i * 4 + 3] = 1; // identity
  return { count, pos, scale, quat, color, opacity, photoreal: false };
}

const TEX_W = 2048;
const TEXELS_PER_SPLAT = 8;

type SplatData = {
  count: number;
  texture: THREE.DataTexture;
  // CPU copies of the animated centres — the depth sort needs to know where each
  // splat currently is, and the morph itself runs on the GPU.
  scatterA: Float32Array;
  textHome: Float32Array;
  modelHome: Float32Array;
  scatterB: Float32Array;
  delayForm: Float32Array;
  delayMorph: Float32Array;
  delayBlast: Float32Array;
};

// Build the whole system: each splat knows its fly-in origin, its seat in the
// text, its place on the model, and where it goes when the model tears apart.
// All of it is packed into a float texture and morphed in the vertex shader —
// at 150k splats a per-frame CPU lerp would not hold 60fps.
function buildSplatData(text: string, src: ModelSource): SplatData {
  const { coords, cw, ch } = sampleTextCoords(text);
  const textCount = Math.max(1, coords.length / 2);
  const count = src.count;

  const scatterA = new Float32Array(count * 3);
  const textHome = new Float32Array(count * 3);
  const modelHome = new Float32Array(count * 3);
  const scatterB = new Float32Array(count * 3);
  const delayForm = new Float32Array(count);
  const delayMorph = new Float32Array(count);
  const delayBlast = new Float32Array(count);

  const worldW = 9;
  const worldH = (worldW * ch) / cw; // keep text aspect

  // model vertical range, for the fallback gradient
  let minY = Infinity;
  let maxY = -Infinity;
  for (let k = 0; k < count; k++) {
    const y = src.pos[k * 3 + 1];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const cAccent = new THREE.Color('#e94560');
  const cTeal = new THREE.Color('#4ecdc4');
  const cWhite = new THREE.Color('#fff2d8');
  const tmp = new THREE.Color();

  const texH = Math.ceil((count * TEXELS_PER_SPLAT) / TEX_W);
  const data = new Float32Array(TEX_W * texH * 4);

  for (let k = 0; k < count; k++) {
    const i3 = k * 3;

    // text home: spread the splats evenly across the rasterised text pixels
    const ti = Math.floor((k * textCount) / count) % textCount;
    const tx = coords[ti * 2] ?? cw / 2;
    const ty = coords[ti * 2 + 1] ?? ch / 2;
    textHome[i3] = (tx / cw - 0.5) * worldW;
    textHome[i3 + 1] = -(ty / ch - 0.5) * worldH;
    textHome[i3 + 2] = (Math.random() - 0.5) * 0.4;

    modelHome[i3] = src.pos[i3];
    modelHome[i3 + 1] = src.pos[i3 + 1];
    modelHome[i3 + 2] = src.pos[i3 + 2];

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

    // staggers: assemble left->right, morph + blast ripple randomly
    const nx = textHome[i3] / worldW + 0.5;
    delayForm[k] = Math.min(0.08, Math.max(0, nx * 0.07 + Math.random() * 0.02));
    delayMorph[k] = Math.random() * 0.08;
    delayBlast[k] = Math.random() * 0.12;

    // text colour: brand palette
    const rc = Math.random();
    const tc = rc < 0.7 ? cAccent : rc < 0.92 ? cTeal : cWhite;

    // model colour: photoreal from the capture, else a brand height gradient
    let mr: number;
    let mg: number;
    let mb: number;
    if (src.photoreal) {
      mr = src.color[i3];
      mg = src.color[i3 + 1];
      mb = src.color[i3 + 2];
    } else if (maxY > minY) {
      tmp.copy(cAccent).lerp(cTeal, (modelHome[i3 + 1] - minY) / (maxY - minY));
      if (Math.random() < 0.1) tmp.copy(cWhite);
      mr = tmp.r;
      mg = tmp.g;
      mb = tmp.b;
    } else {
      mr = tc.r;
      mg = tc.g;
      mb = tc.b;
    }

    // pack 8 RGBA texels per splat (see the fetch() calls in the vertex shader)
    const o = k * TEXELS_PER_SPLAT * 4;
    data[o] = scatterA[i3];
    data[o + 1] = scatterA[i3 + 1];
    data[o + 2] = scatterA[i3 + 2];
    data[o + 3] = delayForm[k];
    data[o + 4] = textHome[i3];
    data[o + 5] = textHome[i3 + 1];
    data[o + 6] = textHome[i3 + 2];
    data[o + 7] = delayMorph[k];
    data[o + 8] = modelHome[i3];
    data[o + 9] = modelHome[i3 + 1];
    data[o + 10] = modelHome[i3 + 2];
    data[o + 11] = delayBlast[k];
    data[o + 12] = scatterB[i3];
    data[o + 13] = scatterB[i3 + 1];
    data[o + 14] = scatterB[i3 + 2];
    data[o + 15] = src.opacity[k];
    data[o + 16] = tc.r;
    data[o + 17] = tc.g;
    data[o + 18] = tc.b;
    data[o + 20] = mr;
    data[o + 21] = mg;
    data[o + 22] = mb;
    data[o + 24] = src.scale[i3];
    data[o + 25] = src.scale[i3 + 1];
    data[o + 26] = src.scale[i3 + 2];
    data[o + 28] = src.quat[k * 4];
    data[o + 29] = src.quat[k * 4 + 1];
    data[o + 30] = src.quat[k * 4 + 2];
    data[o + 31] = src.quat[k * 4 + 3];
  }

  const texture = new THREE.DataTexture(data, TEX_W, texH, THREE.RGBAFormat, THREE.FloatType);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.needsUpdate = true;

  return {
    count,
    texture,
    scatterA,
    textHome,
    modelHome,
    scatterB,
    delayForm,
    delayMorph,
    delayBlast,
  };
}

const f = (n: number) => n.toFixed(5);

// Gaussian splatting proper: project each 3D gaussian's covariance into a 2D
// screen-space ellipse, draw it as an instanced quad with exp() falloff, and
// alpha-blend the lot back-to-front. The morph rides along by lerping the
// centre/colour and blooming the scale from an isotropic text dot into the
// captured anisotropic gaussian.
const SPLAT_VERT = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

in vec3 position;   // quad corner, xy in [-2,2]
in float iIndex;    // which splat this instance draws (depth-sorted each frame)

uniform sampler2D uData;
uniform int uTexW;
uniform float uProgress;
uniform vec2 uFocal;
uniform vec2 uViewport;
uniform float uTextDot;
uniform float uTextAlpha;

out vec4 vColor;
out vec2 vQuad;

vec4 fetch(int i, int t) {
  int k = i * ${TEXELS_PER_SPLAT} + t;
  return texelFetch(uData, ivec2(k % uTexW, k / uTexW), 0);
}

float clamp01(float t) { return clamp(t, 0.0, 1.0); }
float easeOutCubic(float t) { float u = 1.0 - t; return 1.0 - u * u * u; }
float easeInCubic(float t) { return t * t * t; }
float smoothstep01(float t) { return t * t * (3.0 - 2.0 * t); }

mat3 quatToMat(vec4 q) {
  float x = q.x, y = q.y, z = q.z, w = q.w;
  return mat3(
    1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z),       2.0 * (x * z - w * y),
    2.0 * (x * y - w * z),       1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x),
    2.0 * (x * z + w * y),       2.0 * (y * z - w * x),       1.0 - 2.0 * (x * x + y * y)
  );
}

void main() {
  int i = int(iIndex);
  vec4 t0 = fetch(i, 0); // scatterA.xyz, delayForm
  vec4 t1 = fetch(i, 1); // textHome.xyz, delayMorph
  vec4 t2 = fetch(i, 2); // modelHome.xyz, delayBlast
  vec4 t3 = fetch(i, 3); // scatterB.xyz, opacity
  vec4 t4 = fetch(i, 4); // textColor
  vec4 t5 = fetch(i, 5); // modelColor
  vec4 t6 = fetch(i, 6); // scale
  vec4 t7 = fetch(i, 7); // quat xyzw

  float a = easeOutCubic(clamp01((uProgress - t0.w) / ${f(ASSEMBLE_END)}));
  float m = smoothstep01(clamp01((uProgress - ${f(MORPH_START)} - t1.w) / ${f(MORPH_END - MORPH_START)}));
  float b = easeInCubic(clamp01((uProgress - ${f(BLAST_START)} - t2.w) / ${f(1 - BLAST_START)}));

  vec3 base = mix(t0.xyz, t1.xyz, a);
  vec3 formed = mix(base, t2.xyz, m);
  vec3 center = mix(formed, t3.xyz, b);

  vColor = vec4(mix(t4.rgb, t5.rgb, m), mix(uTextAlpha, t3.w, m));

  // text particles are isotropic dots that bloom into the real gaussian
  vec3 scale = mix(vec3(uTextDot), t6.xyz, m);

  vec4 cam = modelViewMatrix * vec4(center, 1.0);
  vec4 clip = projectionMatrix * cam;

  float lim = 1.3 * clip.w;
  if (clip.w <= 0.0 || abs(clip.x) > lim || abs(clip.y) > lim) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0); // offscreen
    return;
  }

  mat3 R = quatToMat(normalize(t7));
  mat3 S = mat3(scale.x, 0.0, 0.0, 0.0, scale.y, 0.0, 0.0, 0.0, scale.z);
  mat3 Mx = R * S;
  mat3 sigma = Mx * transpose(Mx); // 3D covariance = R S S^T R^T

  // Jacobian of the perspective projection at cam (column-major constructor).
  // Its overall sign cancels in T*sigma*T^T, so cam.z < 0 is fine.
  mat3 J = mat3(
    uFocal.x / cam.z, 0.0, 0.0,
    0.0, uFocal.y / cam.z, 0.0,
    -(uFocal.x * cam.x) / (cam.z * cam.z), -(uFocal.y * cam.y) / (cam.z * cam.z), 0.0
  );
  mat3 T = J * mat3(modelViewMatrix);
  mat3 cov = T * sigma * transpose(T);

  // dilate so sub-pixel gaussians stay visible instead of aliasing away
  cov[0][0] += 0.3;
  cov[1][1] += 0.3;

  float mid = 0.5 * (cov[0][0] + cov[1][1]);
  float rad = length(vec2(0.5 * (cov[0][0] - cov[1][1]), cov[0][1]));
  float l1 = mid + rad;
  float l2 = max(mid - rad, 0.1);
  if (l1 < 0.0) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }

  vec2 dv = normalize(vec2(cov[0][1], l1 - cov[0][0]) + vec2(1e-6, 0.0));
  vec2 majorAxis = min(sqrt(2.0 * l1), 1024.0) * dv;
  vec2 minorAxis = min(sqrt(2.0 * l2), 1024.0) * vec2(dv.y, -dv.x);

  vQuad = position.xy;
  // axes are in pixels; NDC spans 2 across the viewport, hence the 2.0
  gl_Position = vec4(
    clip.xy / clip.w
      + position.x * majorAxis * 2.0 / uViewport
      + position.y * minorAxis * 2.0 / uViewport,
    clip.z / clip.w,
    1.0
  );
}
`;

const SPLAT_FRAG = /* glsl */ `
precision highp float;

in vec4 vColor;
in vec2 vQuad;
out vec4 outColor;

void main() {
  float A = -dot(vQuad, vQuad);
  if (A < -4.0) discard;         // outside ~2 sigma
  float B = exp(A) * vColor.a;
  outColor = vec4(vColor.rgb * B, B); // premultiplied
}
`;

const SORT_BUCKETS = 65536;

// Counting sort on view-space depth. Back-to-front == ascending z, since three's
// camera looks down -Z. O(n) — a comparison sort of 150k would blow the frame.
function depthSort(
  data: SplatData,
  p: number,
  mv: THREE.Matrix4,
  order: Float32Array,
  depths: Float32Array,
  buckets: Uint16Array,
  counts: Uint32Array
) {
  const e = mv.elements;
  const n = data.count;
  let dmin = Infinity;
  let dmax = -Infinity;

  for (let k = 0; k < n; k++) {
    const i3 = k * 3;
    const a = easeOutCubic(clamp01((p - data.delayForm[k]) / ASSEMBLE_END));
    const m = smoothstep(
      clamp01((p - MORPH_START - data.delayMorph[k]) / (MORPH_END - MORPH_START))
    );
    const b = easeInCubic(clamp01((p - BLAST_START - data.delayBlast[k]) / (1 - BLAST_START)));

    const x = lerp(lerp(lerp(data.scatterA[i3], data.textHome[i3], a), data.modelHome[i3], m), data.scatterB[i3], b);
    const y = lerp(lerp(lerp(data.scatterA[i3 + 1], data.textHome[i3 + 1], a), data.modelHome[i3 + 1], m), data.scatterB[i3 + 1], b);
    const z = lerp(lerp(lerp(data.scatterA[i3 + 2], data.textHome[i3 + 2], a), data.modelHome[i3 + 2], m), data.scatterB[i3 + 2], b);

    // view-space z only — the sort key
    const d = e[2] * x + e[6] * y + e[10] * z + e[14];
    depths[k] = d;
    if (d < dmin) dmin = d;
    if (d > dmax) dmax = d;
  }

  counts.fill(0);
  const scale = dmax > dmin ? (SORT_BUCKETS - 1) / (dmax - dmin) : 0;
  for (let k = 0; k < n; k++) {
    const bkt = ((depths[k] - dmin) * scale) | 0;
    buckets[k] = bkt;
    counts[bkt]++;
  }
  let sum = 0;
  for (let i = 0; i < SORT_BUCKETS; i++) {
    const c = counts[i];
    counts[i] = sum;
    sum += c;
  }
  for (let k = 0; k < n; k++) order[counts[buckets[k]]++] = k;
}

function SplatCloud({ text, progress }: { text: string; progress: number }) {
  const groupRef = useRef<THREE.Group>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  const smooth = useRef(0);
  const [src, setSrc] = useState<ModelSource | null>(null);
  const { size, camera } = useThree();

  useEffect(() => {
    let cancelled = false;
    const limit =
      typeof window !== 'undefined' && window.innerWidth < 820
        ? MAX_SPLATS_MOBILE
        : MAX_SPLATS_DESKTOP;

    (async () => {
      // real gaussians first; fall back to the bare point cloud (STL path)
      try {
        const r = await fetch(SPLAT_URL);
        if (r.ok) {
          const ab = await r.arrayBuffer();
          if (!cancelled) setSrc(parseSplats(ab, limit));
          return;
        }
      } catch {
        /* fall through */
      }
      try {
        const r = await fetch(POINTS_URL);
        if (r.ok) {
          const ab = await r.arrayBuffer();
          if (!cancelled) setSrc(synthesiseSplats(ab, limit));
        }
      } catch {
        /* nothing to render */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const data = useMemo(() => (src ? buildSplatData(text, src) : null), [text, src]);

  const geometry = useMemo(() => {
    if (!data) return null;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([-2, -2, 0, 2, -2, 0, 2, 2, 0, -2, 2, 0]),
        3
      )
    );
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const order = new Float32Array(data.count);
    for (let i = 0; i < data.count; i++) order[i] = i;
    const attr = new THREE.InstancedBufferAttribute(order, 1);
    attr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iIndex', attr);
    g.instanceCount = data.count;
    return g;
  }, [data]);

  const material = useMemo(() => {
    if (!data) return null;
    return new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uData: { value: data.texture },
        uTexW: { value: TEX_W },
        uProgress: { value: 0 },
        uFocal: { value: new THREE.Vector2(1000, 1000) },
        uViewport: { value: new THREE.Vector2(1, 1) },
        uTextDot: { value: 0.008 },
        uTextAlpha: { value: 0.9 },
      },
      vertexShader: SPLAT_VERT,
      fragmentShader: SPLAT_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      // The quad is spanned by (majorAxis, minorAxis); minorAxis is majorAxis
      // rotated -90 degrees, so that basis always has a negative determinant and
      // the triangles come out back-facing. three.js culls those by default
      // (side: FrontSide) — raw-WebGL splat renderers only get away with the same
      // math because CULL_FACE is off there. Without this, nothing rasterises.
      side: THREE.DoubleSide,
      // premultiplied alpha, since the fragment already multiplies through
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
  }, [data]);

  // Scratch for the sort. Sized inside useFrame rather than in an effect: passive
  // effects can be deferred past the next frame, and a zero-length scratch would
  // silently corrupt the sort into writing garbage indices.
  const sortRef = useRef({
    depths: new Float32Array(0),
    buckets: new Uint16Array(0),
    counts: new Uint32Array(SORT_BUCKETS),
    lastP: -1,
    camKey: -1,
    mv: new THREE.Matrix4(),
  });

  useEffect(() => {
    return () => {
      geometry?.dispose();
      material?.dispose();
      data?.texture.dispose();
    };
  }, [geometry, material, data]);

  useFrame(() => {
    const grp = groupRef.current;
    const mesh = meshRef.current;
    if (!grp || !mesh || !data || !material) return;

    smooth.current = lerp(smooth.current, progress, 0.08);
    const p = smooth.current;

    material.uniforms.uProgress.value = p;
    const cam = camera as THREE.PerspectiveCamera;
    const fy = size.height / (2 * Math.tan(((cam.fov * Math.PI) / 180) / 2));
    material.uniforms.uFocal.value.set(fy, fy);
    material.uniforms.uViewport.value.set(size.width, size.height);

    // Scroll-driven 3D rotation (deterministic + reversible): no rotation while
    // the word is readable, a gentle turn through the morph, then a sweep as the
    // model holds and explodes. Must be a pure function of progress — an
    // accumulator left the word mirrored after scrolling back up.
    const rf = smoothstep(clamp01((p - MORPH_START) / (MORPH_END - MORPH_START)));
    const spinModel = clamp01((p - MORPH_END) / (1 - MORPH_END));
    grp.rotation.y = rf * 0.5 + spinModel * Math.PI;
    grp.rotation.x = -0.35 * rf;

    // Re-sort only when the ordering can actually have changed: the splats moved
    // (progress) or the camera did. Idle frames reuse the last order.
    const st = sortRef.current;
    if (st.buckets.length !== data.count) {
      st.buckets = new Uint16Array(data.count);
      st.depths = new Float32Array(data.count);
      st.lastP = -1;
    }
    const camKey = camera.position.x + camera.position.y * 7.1 + camera.position.z * 13.3;
    if (Math.abs(p - st.lastP) > 0.0005 || Math.abs(camKey - st.camKey) > 0.02) {
      grp.updateMatrixWorld();
      camera.updateMatrixWorld();
      st.mv.copy(camera.matrixWorld).invert().multiply(mesh.matrixWorld);

      const attr = mesh.geometry.getAttribute('iIndex') as THREE.InstancedBufferAttribute;
      depthSort(data, p, st.mv, attr.array as Float32Array, st.depths, st.buckets, st.counts);
      attr.needsUpdate = true;
      st.lastP = p;
      st.camKey = camKey;
    }
  });

  return (
    <group ref={groupRef}>
      {geometry && material && (
        <mesh ref={meshRef} geometry={geometry} material={material} frustumCulled={false} />
      )}
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
      <SplatCloud text={text} progress={progress} />
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
