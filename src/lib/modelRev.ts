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
// Served by src/app/hero-model/[file]/route.ts, which reads them out of
// public/models and adds the Content-Encoding the static file handler will not.
// /hero-model rather than /models because public/ is served BEFORE the app
// router, so a route on the folder's own path is silently shadowed — see the
// route for the measurement. The raw /models/... URLs still work; nothing on the
// site uses them.
export const CAD_URL = `/hero-model/cad-layers.bin?v=${MODEL_REV}`;
export const CAD_INDEX_URL = `/hero-model/cad-layers-index.bin?v=${MODEL_REV}`;
