'use client';

import { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

// Real gaussians from a 3DGS capture: 32 bytes/splat (pos, scale, rgba, quat).
// Written by scripts/model-to-points.mjs from a .ply.
const SPLAT_URL = '/models/mahjong-points-splats.bin';
// Fallback for the CAD STL, which has no gaussian params: plain Float32 xyz.
// Those get synthesised into small isotropic gaussians + a steel height gradient
// so both sources feed the same splat renderer.
const POINTS_URL = '/models/mahjong-points.bin';

// 150k splats is a desktop budget: alpha-blended overdraw plus a per-frame depth
// sort. Small screens get a prefix of the cloud (file order is not spatially
// sorted, so a prefix is an even subset).
const MAX_SPLATS_DESKTOP = 150000;
const MAX_SPLATS_MOBILE = 40000;

// Shader timeline (in effective progress 0..1):
//   0.00-0.18  text assembles (played once, time-driven, on load)
//   0.18-0.30  hold text (readable)
//   0.30-0.55  morph text -> 3D model point cloud (+ 3D rotation ramps in)
//   0.55-0.75  hold model (rotating)
//   0.75-1.00  tear apart / explode
// Scroll maps onto [ASSEMBLE_END, 1]: the assembly beat is an entrance animation,
// not a scroll beat — at rest the page shows the formed word, never raw scatter.
const ASSEMBLE_END = 0.18;
const MORPH_START = 0.3;
const MORPH_END = 0.55;
const BLAST_START = 0.75;
const INTRO_SECONDS = 2.4;
// Per-splat assembly delays go up to MAX_FORM_DELAY, so each splat's travel
// window is ASSEMBLE_END - MAX_FORM_DELAY — that way the *last* splat still
// seats exactly at ASSEMBLE_END. Dividing by ASSEMBLE_END instead left the
// word's right edge permanently ~10% short of home once the intro parked
// progress at ASSEMBLE_END.
const MAX_FORM_DELAY = 0.08;
const ASSEMBLE_WINDOW = ASSEMBLE_END - MAX_FORM_DELAY;

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

// next/font registers its faces under mangled family names ('__Anton_abc123'),
// so a canvas asking for "Anton" silently falls back to Impact/system sans and
// the browser fake-bolds it into mush. Resolve the real family list by probing
// a computed style built from the CSS variables the fonts are exposed through.
function resolveDisplayFamilies() {
  const fallback = '"Heiti SC", "PingFang SC", "Microsoft YaHei", Impact, sans-serif';
  if (typeof document === 'undefined') return fallback;
  const probe = document.createElement('span');
  probe.style.fontFamily = 'var(--font-anton), var(--font-hei)';
  document.body.appendChild(probe);
  const fam = getComputedStyle(probe).fontFamily;
  probe.remove();
  return fam ? `${fam}, ${fallback}` : fallback;
}

// Sampling lattice pitch, px. buildSplatData spreads the splats stacked on one
// sampled pixel back across this cell, so the lattice never shows.
const SAMPLE_STEP = 4;

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

  // Weight 400 on purpose: Anton's single face is registered as 400, and the
  // hanzi face is registered 900-only so nearest-match picks it up — asking for
  // a heavier weight than a face owns makes the canvas synthesize a fake bold
  // that clogs the counters. Tracking keeps particle letters from merging.
  const families = resolveDisplayFamilies();
  const font = (s: number) => `400 ${s}px ${families}`;
  const track = (s: number) => {
    try {
      ctx.letterSpacing = `${Math.round(s * 0.05)}px`;
    } catch {
      /* older engines: no tracking, layout still works */
    }
  };
  let fontSize = 400;
  ctx.font = font(fontSize);
  track(fontSize);
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
  track(fontSize);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lineH = fontSize * 1.08;
  const startY = ch / 2 - ((lines.length - 1) * lineH) / 2;
  lines.forEach((ln, i) => ctx.fillText(ln, cw / 2, startY + i * lineH));

  const img = ctx.getImageData(0, 0, cw, ch).data;
  const coords: number[] = [];
  for (let y = 0; y < ch; y += SAMPLE_STEP) {
    for (let x = 0; x < cw; x += SAMPLE_STEP) {
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
  photoreal: boolean; // false => synthesised, use the steel gradient
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
  // Poster type is shouted: uppercase the latin, CJK passes through unchanged.
  const { coords, cw, ch } = sampleTextCoords(text.toUpperCase());
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

  // Strict monochrome particles with a rare acid strike — poster ink, not confetti.
  const cSmoke = new THREE.Color('#f5f5f3');
  const cGray = new THREE.Color('#8a8a86');
  const cAcid = new THREE.Color('#c6ff00');
  const cCharcoal = new THREE.Color('#2a2a28');
  const tmp = new THREE.Color();

  const texH = Math.ceil((count * TEXELS_PER_SPLAT) / TEX_W);
  const data = new Float32Array(TEX_W * texH * 4);

  for (let k = 0; k < count; k++) {
    const i3 = k * 3;

    // text home: spread the splats evenly across the rasterised text pixels.
    // ~10+ splats share each sampled pixel, so scatter them across the sampling
    // cell — without the jitter they stack into one fat dot per lattice point
    // and the word reads as chunky mush instead of fine grain.
    const cell = (worldW * SAMPLE_STEP) / cw;
    const ti = Math.floor((k * textCount) / count) % textCount;
    const tx = coords[ti * 2] ?? cw / 2;
    const ty = coords[ti * 2 + 1] ?? ch / 2;
    textHome[i3] = (tx / cw - 0.5) * worldW + (Math.random() - 0.5) * cell;
    textHome[i3 + 1] = -(ty / ch - 0.5) * worldH + (Math.random() - 0.5) * cell;
    // thin slab: a deep z-jitter blurs the word's edges
    textHome[i3 + 2] = (Math.random() - 0.5) * 0.18;

    modelHome[i3] = src.pos[i3];
    modelHome[i3 + 1] = src.pos[i3 + 1];
    modelHome[i3 + 2] = src.pos[i3 + 2];

    // fly-in origin: point on a surrounding sphere, kept in front of the camera
    // (z <= ~4 vs camera z=10) — splats that spawn at the near plane project to
    // screen-filling blobs and read as static noise.
    const rA = 7 + Math.random() * 8;
    const thA = Math.random() * Math.PI * 2;
    const phA = Math.acos(2 * Math.random() - 1);
    scatterA[i3] = Math.sin(phA) * Math.cos(thA) * rA;
    scatterA[i3 + 1] = Math.sin(phA) * Math.sin(thA) * rA * 0.75;
    scatterA[i3 + 2] = Math.cos(phA) * rA * 0.65 - 6;

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
    delayForm[k] = Math.min(MAX_FORM_DELAY, Math.max(0, nx * 0.07 + Math.random() * 0.02));
    delayMorph[k] = Math.random() * 0.08;
    delayBlast[k] = Math.random() * 0.12;

    // text colour: smoke body, a little gray shadow, rare acid strikes. Gray
    // kept sparse — too much of it reads as dark mottling inside the letters.
    const rc = Math.random();
    const tc = rc < 0.9 ? cSmoke : rc < 0.955 ? cGray : cAcid;

    // model colour: photoreal from the capture (graded high-contrast B&W in the
    // shader), else a charcoal->smoke height gradient for the bare CAD cloud
    let mr: number;
    let mg: number;
    let mb: number;
    if (src.photoreal) {
      mr = src.color[i3];
      mg = src.color[i3 + 1];
      mb = src.color[i3 + 2];
    } else if (maxY > minY) {
      tmp.copy(cCharcoal).lerp(cSmoke, (modelHome[i3 + 1] - minY) / (maxY - minY));
      if (Math.random() < 0.04) tmp.copy(cAcid);
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
uniform float uMaxAxis; // screen-px cap on the projected ellipse — bounds worst-case fill
uniform float uGrade; // 1 => photoreal capture: grade it into the site's monochrome
uniform vec2 uMouse;  // cursor on the z=0 plane, world units
uniform float uTime;
uniform float uRepel;

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

// Near-total desaturation + contrast punch: silver-gelatin print, not sepia.
vec3 gradeMono(vec3 c) {
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  vec3 d = mix(c, vec3(l), 0.88);
  d = (d - 0.5) * 1.22 + 0.54;
  return clamp(d, 0.0, 1.0);
}

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

  float a = easeOutCubic(clamp01((uProgress - t0.w) / ${f(ASSEMBLE_WINDOW)}));
  float m = smoothstep01(clamp01((uProgress - ${f(MORPH_START)} - t1.w) / ${f(MORPH_END - MORPH_START)}));
  float b = easeInCubic(clamp01((uProgress - ${f(BLAST_START)} - t2.w) / ${f(1 - BLAST_START)}));

  vec3 base = mix(t0.xyz, t1.xyz, a);
  vec3 formed = mix(base, t2.xyz, m);
  vec3 center = mix(formed, t3.xyz, b);

  // Cursor repulsion + idle simmer, text phase only (the photoreal model must
  // not smear). GPU-only offsets are small enough not to upset the CPU depth
  // sort. This is the animejs.com "poke the letters" interaction — a gentle
  // bulge, not a crater (the word is only ~1.5 units tall).
  float live = (1.0 - m) * (1.0 - b) * a;
  vec2 dm = center.xy - uMouse;
  float dl = length(dm);
  center.xy += (dm / max(dl, 0.2)) * exp(-dl * dl * 3.0) * uRepel * live;
  center.x += sin(uTime * 1.1 + iIndex * 0.37) * 0.014 * live;
  center.y += cos(uTime * 1.4 + iIndex * 0.53) * 0.014 * live;

  // In-flight splats stay faint dust and brighten as they seat into the word;
  // the explosion dissolves to black instead of ending on a noise field.
  float dust = mix(0.05, 1.0, a);
  float fade = 1.0 - 0.9 * b;
  vec3 modelCol = mix(t5.rgb, gradeMono(t5.rgb), uGrade);
  vColor = vec4(
    mix(t4.rgb, modelCol, m),
    mix(uTextAlpha * dust, t3.w, m) * fade
  );

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
  vec2 majorAxis = min(sqrt(2.0 * l1), uMaxAxis) * dv;
  vec2 minorAxis = min(sqrt(2.0 * l2), uMaxAxis) * vec2(dv.y, -dv.x);

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
  counts: Uint32Array,
  n: number // sort only the first n splats — the adaptive governor may draw fewer
) {
  const e = mv.elements;
  let dmin = Infinity;
  let dmax = -Infinity;

  for (let k = 0; k < n; k++) {
    const i3 = k * 3;
    const a = easeOutCubic(clamp01((p - data.delayForm[k]) / ASSEMBLE_WINDOW));
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

function SplatCloud({
  text,
  progress,
  onReady,
}: {
  text: string;
  progress: number;
  onReady?: () => void;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  const smooth = useRef(0);
  const intro = useRef(0); // time-driven assembly, plays once after the data lands
  const reducedMotion = useRef(false);
  const [src, setSrc] = useState<ModelSource | null>(null);
  const { size, camera } = useThree();
  const setDpr = useThree((s) => s.setDpr);
  const active = useRef(0); // splats currently drawn (governor may trim)
  const gov = useRef<Governor>({
    ema: 16.7,
    bad: 0,
    good: 0,
    cooldown: 0,
    level: 0,
    dpr0: 0,
    sortEvery: 1,
    frame: 0,
  });

  useEffect(() => {
    reducedMotion.current =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  // r3f's pointer defaults to (0,0) — screen centre — which would dent the
  // middle of the word before the user ever touches the mouse. Only hand the
  // cursor to the shader once it has actually moved.
  const pointerLive = useRef(false);
  useEffect(() => {
    const arm = () => {
      pointerLive.current = true;
    };
    window.addEventListener('pointermove', arm, { once: true, passive: true });
    return () => window.removeEventListener('pointermove', arm);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const limit =
      typeof window !== 'undefined' && window.innerWidth < 820
        ? MAX_SPLATS_MOBILE
        : MAX_SPLATS_DESKTOP;

    (async () => {
      // The word is rasterised in the display faces — request them explicitly
      // (fonts.ready alone only covers faces already used in the DOM), using
      // the resolved next/font family names and the actual glyphs so the
      // subset hanzi face downloads before the first sample.
      try {
        const families = resolveDisplayFamilies();
        await Promise.allSettled([
          document.fonts.load(`400 200px ${families}`, text.toUpperCase()),
          document.fonts.load(`900 200px ${families}`, text.toUpperCase()),
          document.fonts.ready,
        ]);
      } catch {
        /* older browsers: sample whatever is available */
      }
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

  useEffect(() => {
    if (data) onReady?.();
  }, [data, onReady]);

  const geometry = useMemo(() => {
    if (!data) return null;
    const g = new THREE.InstancedBufferGeometry();
    // ±1.7 sigma, not ±2: the gaussian is at 0.3% by the corners, and the
    // smaller quad rasterises ~28% fewer fragments — pure fill-rate savings.
    g.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([-1.7, -1.7, 0, 1.7, -1.7, 0, 1.7, 1.7, 0, -1.7, 1.7, 0]),
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
    if (!data || !src) return null;
    return new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uData: { value: data.texture },
        uTexW: { value: TEX_W },
        uProgress: { value: 0 },
        uFocal: { value: new THREE.Vector2(1000, 1000) },
        uViewport: { value: new THREE.Vector2(1, 1) },
        uTextDot: { value: 0.005 },
        uTextAlpha: { value: 0.82 },
        uMaxAxis: {
          value:
            typeof window !== 'undefined' && window.innerWidth < 820 ? 120 : 220,
        },
        uGrade: { value: src.photoreal ? 1 : 0 },
        uMouse: { value: new THREE.Vector2(99, 99) },
        uTime: { value: 0 },
        uRepel: { value: 0.38 },
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
  }, [data, src]);

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

  useFrame((state, delta) => {
    const grp = groupRef.current;
    const mesh = meshRef.current;
    if (!grp || !mesh || !data || !material) return;

    // Entrance: advance the assembly beat on the clock (capped delta — a
    // backgrounded tab must not fast-forward it), then let scroll drive the rest
    // of the timeline. Reduced motion skips straight to the formed word.
    intro.current = reducedMotion.current
      ? 1
      : Math.min(1, intro.current + Math.min(delta, 0.05) / INTRO_SECONDS);
    smooth.current = lerp(smooth.current, progress, 0.08);
    const p =
      ASSEMBLE_END * easeOutCubic(intro.current) +
      smooth.current * (1 - ASSEMBLE_END);

    material.uniforms.uProgress.value = p;
    const cam = camera as THREE.PerspectiveCamera;
    const fy = size.height / (2 * Math.tan(((cam.fov * Math.PI) / 180) / 2));
    material.uniforms.uFocal.value.set(fy, fy);
    material.uniforms.uViewport.value.set(size.width, size.height);

    // Cursor on the z=0 plane (where the word sits) + clock for the simmer.
    // Reduced motion (or an untouched pointer) parks the cursor far away.
    material.uniforms.uTime.value += Math.min(delta, 0.05);
    if (reducedMotion.current || !pointerLive.current) {
      material.uniforms.uMouse.value.set(99, 99);
    } else {
      const halfH = Math.tan((cam.fov * Math.PI) / 360) * cam.position.z;
      material.uniforms.uMouse.value.set(
        state.pointer.x * halfH * (size.width / size.height),
        state.pointer.y * halfH
      );
    }

    // Scroll-driven 3D rotation (deterministic + reversible): no rotation while
    // the word is readable, a gentle turn through the morph, then a sweep as the
    // model holds and explodes. Must be a pure function of progress — an
    // accumulator left the word mirrored after scrolling back up.
    const rf = smoothstep(clamp01((p - MORPH_START) / (MORPH_END - MORPH_START)));
    const spinModel = clamp01((p - MORPH_END) / (1 - MORPH_END));
    grp.rotation.y = rf * 0.5 + spinModel * Math.PI;
    grp.rotation.x = -0.35 * rf;

    // Re-sort only when the ordering can actually have changed: the splats moved
    // (progress) or the camera did. Idle frames reuse the last order. Degraded
    // devices sort every other frame — one frame of stale order is invisible at
    // these alphas.
    const st = sortRef.current;
    const g = gov.current;
    g.frame++;
    if (st.buckets.length !== data.count) {
      st.buckets = new Uint16Array(data.count);
      st.depths = new Float32Array(data.count);
      st.lastP = -1;
      active.current = data.count;
    }
    (mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = active.current;
    const camKey = camera.position.x + camera.position.y * 7.1 + camera.position.z * 13.3;
    if (
      (Math.abs(p - st.lastP) > 0.0005 || Math.abs(camKey - st.camKey) > 0.02) &&
      g.frame % g.sortEvery === 0
    ) {
      grp.updateMatrixWorld();
      camera.updateMatrixWorld();
      st.mv.copy(camera.matrixWorld).invert().multiply(mesh.matrixWorld);

      const attr = mesh.geometry.getAttribute('iIndex') as THREE.InstancedBufferAttribute;
      depthSort(
        data,
        p,
        st.mv,
        attr.array as Float32Array,
        st.depths,
        st.buckets,
        st.counts,
        active.current
      );
      attr.needsUpdate = true;
      st.lastP = p;
      st.camKey = camKey;
    }

    // Quality governor: EMA over the real frame cadence, act with hysteresis.
    // Skipped until the intro has played so load spikes don't trigger it.
    if (intro.current >= 1) {
      if (g.dpr0 === 0) g.dpr0 = state.viewport.dpr;
      g.ema += (Math.min(delta * 1000, 100) - g.ema) * 0.08;
      if (g.cooldown > 0) g.cooldown--;
      let move = 0;
      if (g.ema > GOV_SLOW_MS) {
        g.good = 0;
        if (++g.bad > 45 && g.cooldown === 0 && g.level < GOV_MAX_LEVEL) move = 1;
      } else if (g.ema < GOV_FAST_MS) {
        g.bad = 0;
        if (++g.good > 240 && g.cooldown === 0 && g.level > 0) move = -1;
      } else {
        g.bad = 0;
        g.good = 0;
      }
      if (move !== 0) {
        g.level += move;
        g.bad = 0;
        g.good = 0;
        g.cooldown = move > 0 ? 120 : 420;
        g.sortEvery = g.level >= 2 ? 2 : 1;
        active.current = Math.floor(data.count * GOV_COUNT[g.level]);
        setDpr(Math.max(1, g.dpr0 * GOV_DPR[g.level]));
        st.lastP = -1; // force a fresh sort at the new count
      }
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

// Adaptive quality governor. The splat cloud is fill-rate-bound on weak GPUs
// (Safari's WebGL runs this at a fraction of Chrome's throughput; phones have
// a fraction of desktop fill). Rather than sniffing browsers, watch the real
// frame cadence and walk a quality ladder: first render scale (dpr), then
// splat density. Every animation beat stays identical — degradation is only
// resolution and grain density. Recovers (with hysteresis) up to the initial
// tier when the device turns out to have headroom.
const GOV_DPR = [1, 0.85, 0.72, 0.72, 0.6];
const GOV_COUNT = [1, 1, 1, 0.7, 0.5];
const GOV_MAX_LEVEL = GOV_DPR.length - 1;
const GOV_SLOW_MS = 26; // sustained above this (≈ <40fps) => degrade
const GOV_FAST_MS = 12.5; // sustained below this => try recovering

type Governor = {
  ema: number;
  bad: number;
  good: number;
  cooldown: number;
  level: number;
  dpr0: number;
  sortEvery: number;
  frame: number;
};
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

// Sparse ambient dust for depth — barely-there ice motes, not confetti.
function BackgroundParticles({ progress }: { progress: number }) {
  const pointsRef = useRef<THREE.Points>(null);

  const positions = useMemo(() => {
    const arr = new Float32Array(160 * 3);
    for (let i = 0; i < 160; i++) {
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
      mat.opacity = lerp(0.07, 0.2, progress);
    }
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial size={0.02} color="#8a8a86" transparent opacity={0.07} sizeAttenuation />
    </points>
  );
}

function Scene({
  progress,
  text,
  onReady,
}: {
  progress: number;
  text: string;
  onReady?: () => void;
}) {
  return (
    <>
      <SplatCloud text={text} progress={progress} onReady={onReady} />
      <BackgroundParticles progress={progress} />
      <CameraRig progress={progress} />
    </>
  );
}

export default function ScrollScene({
  hero,
  stages,
}: {
  hero: {
    title: string;
    eyebrow: string;
    subtitle: string;
    scrollHint: string;
    loading: string;
  };
  stages: { title: string; text: string }[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0);
  const [mounted, setMounted] = useState(false);
  const [ready, setReady] = useState(false);
  const [inView, setInView] = useState(true);
  const handleReady = useCallback(() => setReady(true), []);

  useEffect(() => {
    setMounted(true);
  }, []);

  // The splat cloud is the most expensive thing on the page — stop its render
  // loop entirely once the hero scrolls out of view, instead of burning GPU
  // behind the DOM sections forever. Generous margin so it resumes (and
  // re-sorts) before the canvas is back on screen.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), {
      rootMargin: '30% 0px 30% 0px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, [mounted]);

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
    return <div className="h-[500vh] bg-void" />;
  }

  return (
    <div ref={containerRef} className="relative h-[500vh] bg-void">
      {/* Sticky canvas. antialias off (soft gaussians can't alias, MSAA is pure
          fill-rate cost), opaque canvas in the page background colour (saves
          the compositor a full-screen blend), phones start at a lower render
          scale — the governor inside handles the rest. */}
      <div className="sticky top-0 h-screen w-full overflow-hidden">
        <Canvas
          camera={{ position: [0, 0, 10], fov: 50 }}
          frameloop={inView ? 'always' : 'never'}
          dpr={
            typeof window !== 'undefined' && window.innerWidth < 820
              ? [1, 1.75]
              : [1, 2]
          }
          gl={{ antialias: false, alpha: false, powerPreference: 'high-performance' }}
          onCreated={({ gl }) => gl.setClearColor('#050505', 1)}
        >
          <Scene progress={progress} text={hero.title} onReady={handleReady} />
        </Canvas>

        {/* Vignette + edge fades in ONE element (stacked backgrounds): every div
            layered over the canvas is another full-screen blend the compositor
            pays on every canvas frame — WebKit in particular chokes on it */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background: [
              'linear-gradient(to bottom, rgba(5,5,5,0.9), transparent 7rem)',
              'linear-gradient(to top, rgba(5,5,5,1), transparent 8rem)',
              'radial-gradient(120% 90% at 50% 42%, transparent 42%, rgba(3, 3, 3, 0.8) 100%)',
            ].join(', '),
          }}
        />

        {/* Accessible heading — the particle word is not readable to screen readers */}
        <h1 className="sr-only">{hero.title}</h1>

        {/* Loading shimmer while the splat binary streams in */}
        {!ready && (
          <div className="absolute inset-0 grid place-items-center">
            <div className="flex flex-col items-center gap-5">
              <div className="h-px w-32 bg-white/10 overflow-hidden">
                <div className="h-full w-full bg-acid/90 animate-pulse-soft" />
              </div>
              <p className="font-mono text-[11px] tracking-[0.35em] uppercase text-mute animate-pulse-soft">
                {hero.loading}
              </p>
            </div>
          </div>
        )}

        {/* Hero overlay — eyebrow + subtitle + scroll cue, fade as you scroll */}
        <div
          className="absolute inset-0 flex flex-col items-center justify-end pb-16 md:pb-20 pointer-events-none"
          style={{ opacity: heroOpacity }}
        >
          <div className={ready ? 'animate-fade-up [animation-delay:600ms]' : 'opacity-0'}>
            <p className="font-mono text-[11px] md:text-xs tracking-[0.4em] uppercase text-acid text-center mb-4">
              {hero.eyebrow}
            </p>
            <p className="font-mono text-xs md:text-sm uppercase tracking-[0.25em] text-smoke/80 text-center px-6">
              {hero.subtitle}
            </p>
          </div>
          <div
            className={`mt-10 flex flex-col items-center gap-3 ${
              ready ? 'animate-fade-up [animation-delay:1200ms]' : 'opacity-0'
            }`}
          >
            <span className="font-mono text-[10px] tracking-[0.35em] uppercase text-mute">
              {hero.scrollHint}
            </span>
            <span className="block h-10 w-px bg-gradient-to-b from-acid/80 to-transparent animate-scroll-line" />
          </div>
        </div>

        {/* Stage text overlay — appears as the model tears apart */}
        <div
          className="absolute inset-0 flex items-center pointer-events-none"
          style={{ opacity: progress > 0.7 ? 1 : 0, transition: 'opacity 0.5s' }}
        >
          <div className="max-w-7xl mx-auto px-6 lg:px-8 w-full">
            <div className="relative max-w-md">
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
                  <p className="font-mono text-xs tracking-[0.35em] text-acid mb-5">
                    {String(i + 1).padStart(2, '0')} / {String(stages.length).padStart(2, '0')}
                  </p>
                  <h3 className="font-display text-4xl md:text-6xl uppercase text-smoke tracking-wide mb-5">
                    {stage.title}
                  </h3>
                  <p className="text-mute text-base md:text-lg leading-relaxed border-l border-white/15 pl-5">
                    {stage.text}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Scroll progress rail */}
        <div className="absolute right-6 lg:right-8 top-1/2 -translate-y-1/2 hidden md:flex flex-col items-center gap-3">
          <span className="font-mono text-[10px] text-mute tabular-nums">
            {String(Math.round(progress * 100)).padStart(3, '0')}
          </span>
          <div className="relative h-44 w-px bg-white/10 overflow-hidden">
            <div
              className="absolute top-0 left-0 w-full bg-acid shadow-[0_0_12px_rgba(198,255,0,0.9)]"
              style={{ height: `${progress * 100}%` }}
            />
          </div>
          <span className="font-mono text-[10px] text-mute tabular-nums">100</span>
        </div>
      </div>
    </div>
  );
}
