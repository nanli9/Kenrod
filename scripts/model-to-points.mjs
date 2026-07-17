// Turn a product model into the compact splat cloud the web hero renders.
//
// Supports two inputs:
//   * 3DGS  .ply  (gaussian splat) -> real gaussians: centre, anisotropic scale,
//                                     rotation, opacity and photoreal DC colour
//   * Binary STL  (CAD/mesh)       -> area-weighted surface sampling, positions only
//
// Outputs (to <out>'s directory):
//   PLY -> "<name>-splats.bin"  32 bytes/splat, the standard .splat layout:
//            pos   3 x float32  (12B)
//            scale 3 x float32  (12B)
//            color 4 x uint8    ( 4B)  rgb + opacity
//            quat  4 x uint8    ( 4B)  wxyz, encoded (v*128 + 128)
//   STL -> "<name>.bin"         Float32 xyz (no gaussian params exist for a mesh;
//                               the hero synthesises small isotropic gaussians)
//
// Usage:
//   node scripts/model-to-points.mjs <input.ply|.stl> <output.bin> [count] [--up z|y|-y|...] [--yaw deg] [--min-alpha a]
//   e.g. node scripts/model-to-points.mjs capture.ply public/models/mahjong-points.bin 150000 --up z
//
// NOTE: --up defaults differ per format but are NOT reliable — splat world frames
// are arbitrary per capture tool. Always eyeball the result and re-run with the
// right --up/--yaw. (The Kitty test capture is z-up despite being a splat.)

import fs from 'fs';
import path from 'path';

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const flags = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[i + 1];
}

const inPath = positional[0];
const outPath = positional[1];
const N = parseInt(positional[2] || '14000', 10);
const yaw = ((parseFloat(flags.yaw || '0') || 0) * Math.PI) / 180;
const minAlpha = flags['min-alpha'] !== undefined ? parseFloat(flags['min-alpha']) : 0.25;

if (!inPath || !outPath) {
  console.error('Usage: node scripts/model-to-points.mjs <input.ply|.stl> <output.bin> [count] [--up axis] [--yaw deg] [--min-alpha a]');
  process.exit(1);
}

const isPly = inPath.toLowerCase().endsWith('.ply');
const upAxis = (flags.up || (isPly ? 'y' : 'z')).toLowerCase();

// ------------------------------------------------------------- orientation
// Build the 3x3 world transform as a real matrix (row-major rows[r][c]) so the
// same rotation can be applied to gaussian orientations, not just centres.
function upMatrix(axis) {
  switch (axis) {
    // rows map source (x,y,z) -> three (x,y,z); chosen axis ends up on +Y
    case 'x': return [[0, 1, 0], [1, 0, 0], [0, 0, 1]];   // reflection (det -1)
    case '-x': return [[0, -1, 0], [-1, 0, 0], [0, 0, 1]]; // reflection (det -1)
    case 'y': return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    case '-y': return [[1, 0, 0], [0, -1, 0], [0, 0, -1]];
    case 'z': return [[1, 0, 0], [0, 0, 1], [0, -1, 0]];
    case '-z': return [[1, 0, 0], [0, 0, -1], [0, 1, 0]];
    default: return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  }
}
function matMul(a, b) {
  const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    m[r][c] = a[r][0] * b[0][c] + a[r][1] * b[1][c] + a[r][2] * b[2][c];
  }
  return m;
}
function det3(m) {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  );
}
const yawMatrix = [[Math.cos(yaw), 0, Math.sin(yaw)], [0, 1, 0], [-Math.sin(yaw), 0, Math.cos(yaw)]];
const M = matMul(yawMatrix, upMatrix(upAxis));

function reorient(x, y, z) {
  return [
    M[0][0] * x + M[0][1] * y + M[0][2] * z,
    M[1][0] * x + M[1][1] * y + M[1][2] * z,
    M[2][0] * x + M[2][1] * y + M[2][2] * z,
  ];
}

// A gaussian's covariance transforms as S' = M S M^T, which is quadratic in M —
// so for a reflection (det -1, e.g. --up x) we can negate M to get an equivalent
// proper rotation and still land on the same ellipsoid. Centres keep the real M.
const Mrot = det3(M) < 0 ? M.map((r) => r.map((v) => -v)) : M;

// Rotation matrix -> quaternion (x,y,z,w).
function quatFromMatrix(m) {
  const tr = m[0][0] + m[1][1] + m[2][2];
  let x, y, z, w;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s;
    x = (m[2][1] - m[1][2]) / s;
    y = (m[0][2] - m[2][0]) / s;
    z = (m[1][0] - m[0][1]) / s;
  } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
    const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2;
    w = (m[2][1] - m[1][2]) / s;
    x = 0.25 * s;
    y = (m[0][1] + m[1][0]) / s;
    z = (m[0][2] + m[2][0]) / s;
  } else if (m[1][1] > m[2][2]) {
    const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2;
    w = (m[0][2] - m[2][0]) / s;
    x = (m[0][1] + m[1][0]) / s;
    y = 0.25 * s;
    z = (m[1][2] + m[2][1]) / s;
  } else {
    const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2;
    w = (m[1][0] - m[0][1]) / s;
    x = (m[0][2] + m[2][0]) / s;
    y = (m[1][2] + m[2][1]) / s;
    z = 0.25 * s;
  }
  return [x, y, z, w];
}
const qM = quatFromMatrix(Mrot);

// Hamilton product (x,y,z,w) — applies the world rotation on top of the gaussian's.
function quatMul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

// ------------------------------------------------------------- normalisation
// Centre on the 2nd..98th percentile midpoint and scale the largest percentile
// span to a fixed world size (ignores stray floaters). Returns the scale factor
// so gaussian sizes can be shrunk by the same amount.
function normalise(pos, count) {
  const targetSize = 5;
  const pick = (axis) => {
    const a = new Float64Array(count);
    for (let i = 0; i < count; i++) a[i] = pos[i * 3 + axis];
    a.sort();
    const lo = a[Math.floor(count * 0.02)];
    const hi = a[Math.floor(count * 0.98)];
    return { c: (lo + hi) / 2, span: hi - lo };
  };
  const px = pick(0), py = pick(1), pz = pick(2);
  const scale = targetSize / (Math.max(px.span, py.span, pz.span) || 1);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (pos[i * 3] - px.c) * scale;
    pos[i * 3 + 1] = (pos[i * 3 + 1] - py.c) * scale;
    pos[i * 3 + 2] = (pos[i * 3 + 2] - pz.c) * scale;
  }
  return scale;
}

function writeBin(p, buf) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
}

// ---------------------------------------------------------------- STL (mesh)
function fromStl() {
  const buf = fs.readFileSync(inPath);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const triCount = dv.getUint32(80, true);
  if (84 + triCount * 50 !== buf.length) {
    console.error('Not a binary STL. Convert to binary STL first.');
    process.exit(1);
  }

  const tri = new Float64Array(triCount * 9);
  const cumArea = new Float64Array(triCount);
  let totalArea = 0;
  let off = 84;
  for (let i = 0; i < triCount; i++) {
    off += 12; // skip normal
    const v = [];
    for (let k = 0; k < 3; k++) {
      const r = reorient(dv.getFloat32(off, true), dv.getFloat32(off + 4, true), dv.getFloat32(off + 8, true));
      off += 12;
      v.push(r);
    }
    off += 2;
    const i9 = i * 9;
    for (let k = 0; k < 3; k++) {
      tri[i9 + k * 3] = v[k][0];
      tri[i9 + k * 3 + 1] = v[k][1];
      tri[i9 + k * 3 + 2] = v[k][2];
    }
    const ax = v[1][0] - v[0][0], ay = v[1][1] - v[0][1], az = v[1][2] - v[0][2];
    const bx = v[2][0] - v[0][0], by = v[2][1] - v[0][1], bz = v[2][2] - v[0][2];
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    totalArea += 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
    cumArea[i] = totalArea;
  }

  const pickTri = (r) => {
    let lo = 0, hi = triCount - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cumArea[mid] < r) lo = mid + 1; else hi = mid; }
    return lo;
  };

  const pos = new Float32Array(N * 3);
  for (let n = 0; n < N; n++) {
    const t = pickTri(Math.random() * totalArea) * 9;
    let u = Math.random(), w = Math.random();
    if (u + w > 1) { u = 1 - u; w = 1 - w; }
    for (let j = 0; j < 3; j++) {
      pos[n * 3 + j] = tri[t + j] + u * (tri[t + 3 + j] - tri[t + j]) + w * (tri[t + 6 + j] - tri[t + j]);
    }
  }
  normalise(pos, N);
  writeBin(outPath, Buffer.from(pos.buffer, pos.byteOffset, pos.byteLength));
  console.log(`STL: ${triCount} triangles -> ${N} points (${(pos.byteLength / 1024).toFixed(0)} KB), up=${upAxis}`);
  console.log(`  positions -> ${outPath}`);
  console.log('  (mesh has no gaussian params — the hero renders these as small isotropic splats)');
}

// --------------------------------------------------------------- PLY (3DGS)
const TYPE_SIZE = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
function readProp(dv, off, type, le) {
  switch (type) {
    case 'float': case 'float32': return dv.getFloat32(off, le);
    case 'double': case 'float64': return dv.getFloat64(off, le);
    case 'uchar': case 'uint8': return dv.getUint8(off);
    case 'char': case 'int8': return dv.getInt8(off);
    case 'ushort': case 'uint16': return dv.getUint16(off, le);
    case 'short': case 'int16': return dv.getInt16(off, le);
    case 'uint': case 'uint32': return dv.getUint32(off, le);
    case 'int': case 'int32': return dv.getInt32(off, le);
    default: return 0;
  }
}

function fromPly() {
  const buf = fs.readFileSync(inPath);
  const ehIdx = buf.indexOf(Buffer.from('end_header'));
  if (ehIdx < 0) { console.error('No PLY header found.'); process.exit(1); }
  let bodyOff = ehIdx + 'end_header'.length;
  if (buf[bodyOff] === 0x0d) bodyOff++;
  if (buf[bodyOff] === 0x0a) bodyOff++;

  const header = buf.toString('ascii', 0, ehIdx).split(/\r?\n/);
  let format = 'binary_little_endian';
  let vertexCount = 0;
  const props = [];
  let inVertex = false;
  for (const line of header) {
    const t = line.trim().split(/\s+/);
    if (t[0] === 'format') format = t[1];
    else if (t[0] === 'element') { inVertex = t[1] === 'vertex'; if (inVertex) vertexCount = parseInt(t[2], 10); }
    else if (t[0] === 'property' && inVertex) props.push({ name: t[t.length - 1], type: t[1] });
  }

  const idx = (n) => props.findIndex((p) => p.name === n);
  const iX = idx('x'), iY = idx('y'), iZ = idx('z');
  const iDC0 = idx('f_dc_0'), iDC1 = idx('f_dc_1'), iDC2 = idx('f_dc_2');
  const iRed = idx('red'), iGreen = idx('green'), iBlue = idx('blue');
  const iOpacity = idx('opacity');
  const iS0 = idx('scale_0'), iS1 = idx('scale_1'), iS2 = idx('scale_2');
  const iR0 = idx('rot_0'), iR1 = idx('rot_1'), iR2 = idx('rot_2'), iR3 = idx('rot_3');
  if (iX < 0 || iY < 0 || iZ < 0) { console.error('PLY missing x/y/z.'); process.exit(1); }
  const hasGauss = iS0 >= 0 && iR0 >= 0;
  if (!hasGauss) {
    console.warn('PLY has no scale_*/rot_* — not a 3DGS export. Falling back to isotropic splats.');
  }

  const SH_C0 = 0.28209479177387814;
  const sigmoid = (x) => 1 / (1 + Math.exp(-x));
  const toColor = (dc) => Math.min(1, Math.max(0, 0.5 + SH_C0 * dc));

  if (format === 'ascii') {
    console.error('ASCII 3DGS PLY is not supported for the splat path (exports are binary). Re-export as binary.');
    process.exit(1);
  }

  const le = format === 'binary_little_endian';
  const offs = [];
  let stride = 0;
  for (const p of props) { offs.push(stride); stride += TYPE_SIZE[p.type] || 4; }
  const expected = bodyOff + vertexCount * stride;
  if (expected > buf.length) {
    console.error(`PLY body truncated: header wants ${expected} bytes, file is ${buf.length}.`);
    process.exit(1);
  }
  const dv = new DataView(buf.buffer, buf.byteOffset + bodyOff, buf.byteLength - bodyOff);
  const rd = (b, i) => readProp(dv, b + offs[i], props[i].type, le);

  // Pass 1: which gaussians survive the opacity floor.
  const keep = [];
  for (let v = 0; v < vertexCount; v++) {
    const b = v * stride;
    const alpha = iOpacity >= 0 ? sigmoid(rd(b, iOpacity)) : 1;
    if (alpha >= minAlpha) keep.push(v);
  }
  const kept = keep.length;
  if (kept === 0) { console.error('No gaussians kept — lower --min-alpha.'); process.exit(1); }

  // Pass 2: subsample kept -> N, decoding full gaussian params.
  const count = Math.min(N, kept);
  const step = kept / count;
  const pos = new Float32Array(count * 3);
  const scl = new Float32Array(count * 3);
  const col = new Float32Array(count * 4);
  const quat = new Float32Array(count * 4);

  for (let n = 0; n < count; n++) {
    const b = keep[Math.floor(n * step)] * stride;

    const r = reorient(rd(b, iX), rd(b, iY), rd(b, iZ));
    pos[n * 3] = r[0]; pos[n * 3 + 1] = r[1]; pos[n * 3 + 2] = r[2];

    // 3DGS stores scale in log space and rotation as a (w,x,y,z) quaternion.
    if (hasGauss) {
      scl[n * 3] = Math.exp(rd(b, iS0));
      scl[n * 3 + 1] = Math.exp(rd(b, iS1));
      scl[n * 3 + 2] = Math.exp(rd(b, iS2));
      const qw = rd(b, iR0), qx = rd(b, iR1), qy = rd(b, iR2), qz = rd(b, iR3);
      const len = Math.hypot(qw, qx, qy, qz) || 1;
      const q = quatMul(qM, [qx / len, qy / len, qz / len, qw / len]);
      quat[n * 4] = q[0]; quat[n * 4 + 1] = q[1]; quat[n * 4 + 2] = q[2]; quat[n * 4 + 3] = q[3];
    } else {
      scl[n * 3] = scl[n * 3 + 1] = scl[n * 3 + 2] = 0.004;
      quat[n * 4 + 3] = 1;
    }

    if (iDC0 >= 0) {
      col[n * 4] = toColor(rd(b, iDC0));
      col[n * 4 + 1] = toColor(rd(b, iDC1));
      col[n * 4 + 2] = toColor(rd(b, iDC2));
    } else if (iRed >= 0) {
      col[n * 4] = rd(b, iRed) / 255;
      col[n * 4 + 1] = rd(b, iGreen) / 255;
      col[n * 4 + 2] = rd(b, iBlue) / 255;
    } else {
      col[n * 4] = col[n * 4 + 1] = col[n * 4 + 2] = 1;
    }
    col[n * 4 + 3] = iOpacity >= 0 ? sigmoid(rd(b, iOpacity)) : 1;
  }

  // Normalising the centres must shrink the gaussians by the same factor.
  const s = normalise(pos, count);
  for (let i = 0; i < count * 3; i++) scl[i] *= s;

  // Pack to the 32-byte .splat layout.
  const out = Buffer.alloc(count * 32);
  const u8 = (v) => Math.max(0, Math.min(255, Math.round(v)));
  for (let n = 0; n < count; n++) {
    const o = n * 32;
    out.writeFloatLE(pos[n * 3], o);
    out.writeFloatLE(pos[n * 3 + 1], o + 4);
    out.writeFloatLE(pos[n * 3 + 2], o + 8);
    out.writeFloatLE(scl[n * 3], o + 12);
    out.writeFloatLE(scl[n * 3 + 1], o + 16);
    out.writeFloatLE(scl[n * 3 + 2], o + 20);
    out[o + 24] = u8(col[n * 4] * 255);
    out[o + 25] = u8(col[n * 4 + 1] * 255);
    out[o + 26] = u8(col[n * 4 + 2] * 255);
    out[o + 27] = u8(col[n * 4 + 3] * 255);
    // quat wxyz, encoded v*128 + 128
    out[o + 28] = u8(quat[n * 4 + 3] * 128 + 128);
    out[o + 29] = u8(quat[n * 4] * 128 + 128);
    out[o + 30] = u8(quat[n * 4 + 1] * 128 + 128);
    out[o + 31] = u8(quat[n * 4 + 2] * 128 + 128);
  }

  const splatPath = outPath.replace(/\.bin$/, '') + '-splats.bin';
  writeBin(splatPath, out);

  let sMin = Infinity, sMax = -Infinity, sSum = 0;
  for (let i = 0; i < count * 3; i++) { const v = scl[i]; if (v < sMin) sMin = v; if (v > sMax) sMax = v; sSum += v; }
  console.log(`PLY: ${vertexCount} gaussians, ${kept} kept (alpha>=${minAlpha}) -> ${count} splats, up=${upAxis} yaw=${(yaw * 180) / Math.PI}`);
  console.log(`  splats -> ${splatPath} (${(out.length / 1048576).toFixed(2)} MB)`);
  console.log(`  gaussian scale: min=${sMin.toFixed(4)} mean=${(sSum / (count * 3)).toFixed(4)} max=${sMax.toFixed(4)} (world units, model spans ~5)`);
}

if (isPly) fromPly();
else fromStl();
