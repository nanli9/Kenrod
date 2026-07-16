// Sample a product model's surface into a compact point cloud for the web hero.
//
// Supports two inputs:
//   * Binary STL  (CAD/mesh)      -> area-weighted surface sampling, no colour
//   * 3DGS  .ply  (gaussian splat)-> gaussian centres + per-point photoreal colour
//
// Outputs:
//   <out>.bin           Float32 xyz * N   (always)
//   <out coloured>.bin  Float32 rgb * N   (PLY only, written next to <out> as
//                       "<name>-colors.bin"; the hero loads it if present)
//
// Usage:
//   node scripts/model-to-points.mjs <input.stl|.ply> <output.bin> [count] [--up z|y|-y|...] [--yaw deg] [--min-alpha a]
//   e.g. node scripts/model-to-points.mjs capture.ply public/models/mahjong-points.bin 20000 --up y
//
// Re-run when the complete model / a new capture arrives — no app code changes.

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
  console.error('Usage: node scripts/model-to-points.mjs <input.stl|.ply> <output.bin> [count] [--up axis] [--yaw deg] [--min-alpha a]');
  process.exit(1);
}

const isPly = inPath.toLowerCase().endsWith('.ply');
// Default "up" axis: STL from CAD is Z-up; splats are usually Y-up.
const upAxis = (flags.up || (isPly ? 'y' : 'z')).toLowerCase();

// Map a source point so the chosen source axis points to three.js +Y, then yaw.
function reorient(x, y, z) {
  let v;
  switch (upAxis) {
    case 'x': v = [y, x, z]; break;
    case '-x': v = [-y, -x, z]; break;
    case 'y': v = [x, y, z]; break;
    case '-y': v = [x, -y, -z]; break;
    case 'z': v = [x, z, -y]; break;
    case '-z': v = [x, -z, y]; break;
    default: v = [x, y, z];
  }
  if (yaw) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    v = [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
  }
  return v;
}

// Robust normalise: centre on the 2nd..98th percentile midpoint and scale the
// largest percentile span to a fixed world size (ignores stray outliers).
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
}

function writeBin(p, arr) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
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
  writeBin(outPath, pos);
  console.log(`STL: ${triCount} triangles -> ${N} points (${(pos.byteLength / 1024).toFixed(0)} KB), up=${upAxis}`);
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
  const props = []; // {name, type} for the vertex element, in order
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
  const iRed = idx('red'), iOpacity = idx('opacity');
  if (iX < 0 || iY < 0 || iZ < 0) { console.error('PLY missing x/y/z.'); process.exit(1); }

  const SH_C0 = 0.28209479177387814;
  const sigmoid = (x) => 1 / (1 + Math.exp(-x));
  const toColor = (dc) => Math.min(1, Math.max(0, 0.5 + SH_C0 * dc));

  // gather kept points
  const keepPos = [];
  const keepCol = [];

  if (format === 'ascii') {
    const body = buf.toString('ascii', bodyOff).trim().split(/\s+/);
    const stride = props.length;
    for (let v = 0; v < vertexCount; v++) {
      const base = v * stride;
      const alpha = iOpacity >= 0 ? sigmoid(parseFloat(body[base + iOpacity])) : 1;
      if (alpha < minAlpha) continue;
      const r = reorient(+body[base + iX], +body[base + iY], +body[base + iZ]);
      keepPos.push(r[0], r[1], r[2]);
      if (iDC0 >= 0) keepCol.push(toColor(+body[base + iDC0]), toColor(+body[base + iDC1]), toColor(+body[base + iDC2]));
      else if (iRed >= 0) keepCol.push(+body[base + iRed] / 255, +body[base + idx('green')] / 255, +body[base + idx('blue')] / 255);
      else keepCol.push(1, 1, 1);
    }
  } else {
    const le = format === 'binary_little_endian';
    const offs = [];
    let stride = 0;
    for (const p of props) { offs.push(stride); stride += TYPE_SIZE[p.type] || 4; }
    const dv = new DataView(buf.buffer, buf.byteOffset + bodyOff, buf.byteLength - bodyOff);
    for (let v = 0; v < vertexCount; v++) {
      const b = v * stride;
      const alpha = iOpacity >= 0 ? sigmoid(readProp(dv, b + offs[iOpacity], props[iOpacity].type, le)) : 1;
      if (alpha < minAlpha) continue;
      const x = readProp(dv, b + offs[iX], props[iX].type, le);
      const y = readProp(dv, b + offs[iY], props[iY].type, le);
      const z = readProp(dv, b + offs[iZ], props[iZ].type, le);
      const r = reorient(x, y, z);
      keepPos.push(r[0], r[1], r[2]);
      if (iDC0 >= 0) {
        keepCol.push(
          toColor(readProp(dv, b + offs[iDC0], props[iDC0].type, le)),
          toColor(readProp(dv, b + offs[iDC1], props[iDC1].type, le)),
          toColor(readProp(dv, b + offs[iDC2], props[iDC2].type, le))
        );
      } else if (iRed >= 0) {
        keepCol.push(
          readProp(dv, b + offs[iRed], props[iRed].type, le) / 255,
          readProp(dv, b + offs[idx('green')], props[idx('green')].type, le) / 255,
          readProp(dv, b + offs[idx('blue')], props[idx('blue')].type, le) / 255
        );
      } else keepCol.push(1, 1, 1);
    }
  }

  const kept = keepPos.length / 3;
  if (kept === 0) { console.error('No gaussians kept — lower --min-alpha.'); process.exit(1); }

  // subsample kept -> N
  const count = Math.min(N, kept);
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const stride = kept / count;
  for (let n = 0; n < count; n++) {
    const s = Math.floor(n * stride);
    for (let j = 0; j < 3; j++) {
      pos[n * 3 + j] = keepPos[s * 3 + j];
      col[n * 3 + j] = keepCol[s * 3 + j];
    }
  }
  normalise(pos, count);

  const colorsPath = outPath.replace(/\.bin$/, '') + '-colors.bin';
  writeBin(outPath, pos);
  writeBin(colorsPath, col);
  console.log(`PLY: ${vertexCount} gaussians, ${kept} kept (alpha>=${minAlpha}) -> ${count} points, up=${upAxis} yaw=${(yaw * 180) / Math.PI}`);
  console.log(`  positions -> ${outPath} (${(pos.byteLength / 1024).toFixed(0)} KB)`);
  console.log(`  colors    -> ${colorsPath} (${(col.byteLength / 1024).toFixed(0)} KB)`);
}

if (isPly) fromPly();
else fromStl();
