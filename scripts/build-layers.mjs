// Build the explode-beat layer clouds from the per-layer 3DGS captures.
//
//   node scripts/build-layers.mjs [--count N] [--out public/models/layers]
//   node scripts/build-layers.mjs --index-only     # rewrite the sidecar alone
//
// --index-only rebuilds public/models/layers-index.bin from the manifest this
// script already wrote, without touching the point clouds. The sidecar is a few
// dozen bytes and the clouds take minutes to reconvert, so a change to what the
// renderer needs to know about a layer should not cost a full rebuild.
//
// Reads assets/captures/layers.json — the layout copied from the Blender
// project's 05_exports/demo/sprites_web.json (titles, order, explode offsets)
// merged with each layer's true subject frame from photo/<key>/cameras.json —
// and converts every cleanply/*.ply through model-to-points.mjs.
//
// The point of this script is the shared frame. Each layer was trained on a
// camera sphere fitted to *that layer*, so every capture comes out of
// nerfstudio centred at the origin at a similar size. Converting them one by
// one with the default self-fitting normalise would stack nine concentric
// clouds. Instead each layer is --place'd at its real centre and radius inside
// one --frame (the whole table's), so they reassemble into the machine.
//
// Writes <out>/<key>.bin plus <out>/manifest.json for the renderer.

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const root = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 ? argv[i + 1] : d;
};
const COUNT = parseInt(flag('count', '150000'), 10);
const OUT = path.resolve(root, flag('out', 'public/models/layers'));
const SPEC = path.join(root, 'assets/captures/layers.json');
const INDEX_ONLY = argv.includes('--index-only');

const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));
const captures = path.dirname(SPEC);

// The sidecar the renderer reads alongside the concatenated cloud:
//
//   [u32 layerCount][per layer: u32 offset, u32 count, f32 explodeY, f32 stack]
//
// Self-describing, so the hero needs no second JSON fetch to know where each
// capture starts, how far the CAD explode pulls it, or where it sits in the
// stack. The last two are what the closing exploded-diagram beat is built on —
// the reference drawing's geometry, not a hand-tuned imitation of it.
//
// The original sidecar carried only the first two fields. Both forms are still
// readable: a layer stride of 8 bytes instead of 16 is the tell, and a renderer
// that finds the short form falls back to even spacing by stack order.
const LAYER_STRIDE = 16;
function writeIndex(layers) {
  const side = Buffer.alloc(4 + layers.length * LAYER_STRIDE);
  side.writeUInt32LE(layers.length, 0);
  layers.forEach((L, i) => {
    const o = 4 + i * LAYER_STRIDE;
    side.writeUInt32LE(L.offset, o);
    side.writeUInt32LE(L.splats, o + 4);
    side.writeFloatLE(L.explode_dy, o + 8);
    // The assembled table (00) is not a part of the stack — it is the whole
    // machine — so it has no stack index. -1 tells the renderer to leave it out
    // of the exploded diagram rather than parking it on top of its own parts.
    side.writeFloatLE(L.stack_index == null ? -1 : L.stack_index, o + 12);
  });
  fs.writeFileSync(path.join(root, 'public/models/layers-index.bin'), side);
  return side;
}

if (INDEX_ONLY) {
  const mf = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));
  const side = writeIndex(mf.layers);
  console.log(`sidecar -> public/models/layers-index.bin (${side.length} B, ${mf.layers.length} layers)`);
  for (const L of mf.layers) {
    console.log(`  ${L.key.padEnd(22)} off ${String(L.offset).padStart(7)}  n ${String(L.splats).padStart(6)}  dy ${L.explode_dy}  stack ${L.stack_index}`);
  }
  process.exit(0);
}

// The shared world: the assembled table's own centre and largest dimension.
// Every layer is fitted relative to this, so "5 units" means the same thing in
// each file and the hero can swap or stack them without rescaling.
const table = spec.layers.find((l) => l.key === '00_entire_table');
if (!table) throw new Error('layers.json has no 00_entire_table to anchor the frame');
const frameSize = Math.max(...table.subject.bbox_dims);
const frame = [...table.subject.center, frameSize].join(',');

fs.mkdirSync(OUT, { recursive: true });
const manifest = {
  note: 'Explode-beat layers. Positions share one world; see scripts/build-layers.mjs.',
  frame: { center: table.subject.center, size_m: frameSize, world_units: 5 },
  clearance_m: spec.clearance_m,
  layers: [],
};

for (const L of spec.layers) {
  const ply = path.join(captures, L.ply);
  if (!fs.existsSync(ply)) {
    console.warn(`SKIP ${L.key} — missing ${path.relative(root, ply)}`);
    continue;
  }
  const place = [...L.subject.center, L.subject.bounding_radius].join(',');
  // model-to-points.mjs derives "<out minus .bin>-splats.bin" for the PLY path.
  const stem = path.join(OUT, L.key + '.bin');
  const out = execFileSync(
    'node',
    [path.join(root, 'scripts/model-to-points.mjs'), ply, stem, String(COUNT),
     '--up', 'z', '--place', place, '--frame', frame],
    { encoding: 'utf8' }
  );
  process.stdout.write(out);

  const file = path.join(OUT, L.key + '-splats.bin');
  manifest.layers.push({
    key: L.key,
    title: L.title,
    title_cn: L.title_cn,
    pitch: L.pitch,
    order: L.order,
    stack_index: L.stack_index,
    // How far the demo separates this layer, straight up. Authored in metres
    // (layer 07's 0.265 is the spec's own clearance_m), so it converts with the
    // same factor as the positions — explode_dy is ready to add to y.
    explode_dz_m: L.explode_dz,
    explode_dy: +(L.explode_dz * (5 / frameSize)).toFixed(4),
    file: path.relative(path.join(root, 'public'), file).split(path.sep).join('/'),
    splats: fs.statSync(file).size / 32,
    bytes: fs.statSync(file).size,
  });
}

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const total = manifest.layers.reduce((s, l) => s + l.bytes, 0);
console.log(`\n${manifest.layers.length} layers -> ${path.relative(root, OUT)}`);
console.log(`total ${(total / 1048576).toFixed(2)} MB, ${manifest.layers.reduce((s, l) => s + l.splats, 0)} splats`);

// ------------------------------------------------------------ sequence cloud
// The hero streams one file, not nine, and walks it a capture at a time: the
// whole table first, then each subassembly as the page scrolls.
//
// Layers are CONCATENATED in order, at full capture quality — no thinning and
// no interleaving. Both are deliberate. Only one capture is ever on screen, so
// the raster cost is a single layer's worth however many are in the file, and
// subsampling would visibly degrade the thing the beat exists to show. Keeping
// each layer contiguous also means the two captures alive during a crossfade
// are one adjacent span, which is what the renderer sorts and draws.
//
// Within a layer the order stays the capture's own, which is non-spatial, so a
// small screen can take a prefix of each range and thin it evenly.
const seq = manifest.layers; // 00 first, then 01..08
const bufs = seq.map((L) => fs.readFileSync(path.join(root, 'public', L.file)));
const totalSplats = bufs.reduce((s, b) => s + b.length / 32, 0);
const cloud = Buffer.concat(bufs);
let off = 0;
seq.forEach((L, i) => {
  manifest.layers[i].offset = off;
  off += bufs[i].length / 32;
});
fs.writeFileSync(path.join(root, 'public/models/layers-splats.bin'), cloud);
const side = writeIndex(manifest.layers);
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log(`\nsequence -> public/models/layers-splats.bin`);
console.log(`  ${seq.length} captures, ${totalSplats} splats at full quality, ${(cloud.length / 1048576).toFixed(2)} MB + ${side.length} B index`);
console.log(`  largest capture ${Math.max(...bufs.map((b) => b.length / 32))} splats — that is the per-frame draw`);
