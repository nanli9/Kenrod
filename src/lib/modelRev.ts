// Cache-busting stamp on every model URL, and the URLs themselves.
//
// This lives in its own module rather than beside the scene that fetches it
// because three places now have to agree on the exact byte string: the scene's
// own fetch, the <link rel="preload"> in the locale layout that starts that
// fetch during HTML parse, and the route that serves the bytes. A preload whose
// URL differs from the fetch's by one character is not a no-op — it downloads
// 7.3 MB twice.
//
// The files are served `immutable` for a year (see the route), so a rebuilt
// binary at the same URL would never be picked up. BUMP THIS whenever any .bin
// under public/models is regenerated; it is the only thing that invalidates a
// returning visitor.
// (Still '1': the binaries themselves have not been rebuilt. The URL below moved,
// which is a fresh URL and needs no stamp change of its own.)
export const MODEL_REV = '1';

// What MODEL_REV above is currently a stamp FOR: the first 12 hex digits of the
// SHA-256 of each binary, in the order [cad-layers.bin, cad-layers-index.bin].
//
// This exists because the stamp was an instruction to a human and the failure it
// guards against is silent, delayed by up to a year, and invisible in every test:
// regenerate the geometry, forget to bump, and every returning visitor renders
// last month's model through this month's parser until the cache expires. Nothing
// connected the string to the bytes.
//
// scripts/precompress.mjs already reads both files on every build, so it checks
// these and FAILS THE BUILD if they disagree. That turns a year-long silent bug
// into a five-second edit at the moment the geometry changes. Bump MODEL_REV and
// paste the two hashes the script prints.
export const MODEL_HASH: readonly [string, string] = ['4481d8b261a8', '4490a67a64cf'];

// The machine, and the only geometry the hero downloads. Written by
// scripts/build-cad-layers.py; the sidecar carries the CAD explode offsets, so
// the diagram's layout comes out of the file rather than being guessed in the
// scene. Both halves are required — a vertex block without the sidecar that says
// which bytes are which shape is not a partial success, it is nothing.
//
// THESE POINT AT THE .br FILES ON PURPOSE, AND NOTHING DECOMPRESSES THEM IN JS.
//
// They used to go through /hero-model/[file], a route that read Accept-Encoding
// and picked an encoding to answer with. That route is gone: `output: 'export'`
// has no server to run it, and the site is now a bucket. What replaces it is the
// bucket itself — scripts/deploy-oss.sh uploads cad-layers.bin.br with
// `Content-Encoding: br` in its object metadata, so the browser is told the
// bytes are brotli and inflates them transparently on the way into fetch(). By
// the time parseCadLayers sees the ArrayBuffer it holds the same 7,628,072 bytes
// it always did.
//
// This is strictly better than what the route achieved on Vercel, which
// re-compressed the response at its own lower quality and shipped 5,548,975
// bytes. Straight off the bucket it is the 4,132,280-byte q11 file.
//
// THE FAILURE MODE IS SILENT AND TOTAL. If the metadata is missing — a manual
// upload, a console drag-and-drop, a sync tool that does not preserve headers —
// the browser receives raw brotli, hands 4 MB of compressed noise to
// parseCadLayers, and the magic-number check fails. Blank hero, no console
// error worth the name, and a file that looks fine in the bucket listing. Deploy
// with the script; scripts/verify-oss.sh exists to prove the header survived.
export const CAD_URL = `/models/cad-layers.bin.br?v=${MODEL_REV}`;
export const CAD_INDEX_URL = `/models/cad-layers-index.bin.br?v=${MODEL_REV}`;
