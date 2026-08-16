import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';

// Serves the hero's model binaries with a Content-Encoding the static file
// server will not set.
//
// The problem this exists for is in scripts/precompress.mjs: Next's bundled
// `compression` middleware skips `application/octet-stream` by design, so the
// 7.27 MB vertex block went over the wire uncompressed while every .js chunk
// beside it got gzip. 3.33 MB of a 7.27 MB transfer, on the one asset the whole
// hero waits for. Precompressing is half the fix; something has to say so in a
// header, and that is here.
//
// A route rather than server config because the deployment is `next start` under
// pm2 (scripts/deploy.sh) with no proxy in front of it, and because a route is
// the one answer that also survives `node server.js` in a container or any host
// that runs the same handler. It costs a request handler on an asset fetched
// once per visitor per year.
//
// AND IT IS MOUNTED AT /hero-model, NOT /models, WHICH IS NOT COSMETIC. Next's
// static file handler serves public/ before it reaches the app router, so a route
// at /models/[file] is shadowed by public/models/cad-layers.bin and never runs —
// verified against the built server, which answered with Content-Length 7628072
// and no Content-Encoding at all. The files stay where they are and the raw URL
// still works; the app fetches them through here instead. A name a whole word
// apart from the folder, rather than /model vs /models, so nobody can restore the
// bug by fixing a typo.
const DIR = path.join(process.cwd(), 'public', 'models');

// An allowlist, not a sanitiser. The segment arrives from the URL, and joining
// user-controlled text onto a filesystem path is the classic way to serve
// /etc/passwd; there are exactly two files here and naming them is both safer and
// shorter than trying to prove a traversal check is airtight.
const FILES = new Set(['cad-layers.bin', 'cad-layers-index.bin']);

// Encodings this route can hand back, best first. Each is a file that
// precompress.mjs wrote beside the raw one.
const ENCODINGS = [
  { token: 'br', ext: '.br' },
  { token: 'gzip', ext: '.gz' },
] as const;

// A real token parse, not a substring test. `br` is a substring of `brotli` and
// of several malformed headers, and handing brotli bytes to a client that did
// not ask for them produces an ArrayBuffer that fails parseCadLayers' magic check
// — i.e. a blank hero, not a warning. Also honours `q=0`, which is how a client
// says it will NOT take an encoding.
function accepts(header: string | null, token: string) {
  if (!header) return false;
  for (const part of header.split(',')) {
    const [name, ...params] = part.trim().split(';');
    if (name.trim().toLowerCase() !== token) continue;
    const q = params.map((s) => s.trim().toLowerCase()).find((s) => s.startsWith('q='));
    return !q || parseFloat(q.slice(2)) > 0;
  }
  return false;
}

// Read once and hold it. These are the same bytes for every visitor until the
// exporter runs again, and the process is long-lived — re-reading and re-copying
// 4 MB per request is pure GC pressure. Keyed by the file actually sent, so the
// raw fallback and the two encodings are cached independently, which bounds this
// at 2 files x 3 encodings = 17 MB resident if every variant is ever asked for.
// In practice it is the 4.1 MB brotli copy and nothing else.
const cache = new Map<string, Buffer>();
async function load(name: string) {
  const hit = cache.get(name);
  if (hit) return hit;
  const buf = await readFile(path.join(DIR, name));
  cache.set(name, buf);
  return buf;
}

export async function GET(req: Request, ctx: { params: Promise<{ file: string }> }) {
  const { file } = await ctx.params;
  if (!FILES.has(file)) return new NextResponse('Not found', { status: 404 });

  const accept = req.headers.get('accept-encoding');
  let body: Buffer | null = null;
  let encoding = '';
  for (const enc of ENCODINGS) {
    if (!accepts(accept, enc.token)) continue;
    try {
      body = await load(file + enc.ext);
      encoding = enc.token;
      break;
    } catch {
      // precompress.mjs has not run, or ran before this file existed. Fall
      // through to the next encoding and then to the raw bytes: a slow hero is a
      // working hero, a 500 is not.
    }
  }
  if (!body) {
    try {
      body = await load(file);
    } catch {
      return new NextResponse('Not found', { status: 404 });
    }
  }

  const headers = new Headers({
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(body.byteLength),
    // The same year the static path was serving. Safe for the same reason it was
    // there: the URLs carry a ?v= stamp (see src/lib/modelRev.ts) and nothing
    // else invalidates them.
    'Cache-Control': 'public, max-age=31536000, immutable',
    // Mandatory once the body depends on a request header — without it a shared
    // cache can hand brotli bytes to a client that asked for identity.
    Vary: 'Accept-Encoding',
  });
  if (encoding) headers.set('Content-Encoding', encoding);
  return new NextResponse(new Uint8Array(body), { headers });
}
