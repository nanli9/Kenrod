#!/bin/bash
# Build the static site and push it to an Alibaba Cloud OSS bucket.
#
# This script is not a convenience. Two headers that used to come from
# application code have nowhere else to live now that the site is a bucket:
#
#   Content-Encoding: br   on the model binaries. The hero fetches
#                          /models/cad-layers.bin.br and does NOT decompress it
#                          in JS — it relies on the browser inflating the body
#                          because this header said to. Without it, fetch()
#                          hands parseCadLayers 4 MB of compressed noise, the
#                          magic-number check fails, and the hero is blank with
#                          nothing useful in the console.
#
#   Cache-Control: immutable   on /models/ and /_next/static/. The model URLs
#                              are busted only by MODEL_REV (src/lib/modelRev.ts);
#                              this is the header that makes that stamp mean
#                              something.
#
# Uploading out/ by dragging it into the OSS console sets neither. The site will
# look deployed and the hero will not render.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${OSS_BUCKET:?set OSS_BUCKET, e.g. export OSS_BUCKET=kenrod-site}"
: "${NEXT_PUBLIC_SITE_URL:?set NEXT_PUBLIC_SITE_URL, e.g. export NEXT_PUBLIC_SITE_URL=https://kenrod.com}"

# oss-cn-hongkong: outside the mainland, so no ICP filing is required, and not
# behind the GFW, so it resolves from the mainland without a VPN.
OSS_ENDPOINT="${OSS_ENDPOINT:-oss-cn-hongkong.aliyuncs.com}"
DEST="oss://${OSS_BUCKET}"
OSSUTIL="${OSSUTIL:-ossutil}"

command -v "$OSSUTIL" >/dev/null || {
  echo "ossutil not found. https://help.aliyun.com/document_detail/120075.html" >&2
  exit 1
}

echo "=== Building (NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL) ==="
# The origin is compiled into robots.txt and sitemap.xml at build time. A bucket
# cannot work it out later, which is why this is required above rather than
# defaulted — a wrong value here ships a sitemap advertising localhost.
rm -rf out
npm run build

[ -f out/models/cad-layers.bin.br ] || { echo "out/models/cad-layers.bin.br missing — did prebuild run?" >&2; exit 1; }

# macOS litters these through anything it has opened. They are not secret, just
# noise, and .DS_Store in a public bucket lists your local filenames.
find out -name '.DS_Store' -delete

# The .gz copies and the raw .bin are dead weight here: nothing references them
# now that CAD_URL points at the .br. Keeping them would triple the bucket's
# largest asset for no reader. precompress.mjs still writes them because the
# pm2/Docker deploy path still negotiates encodings.
rm -f out/models/*.gz out/models/cad-layers.bin out/models/cad-layers-index.bin out/models/.gitkeep

COMMON=(--endpoint "$OSS_ENDPOINT" -f)

# ossutil 1.x takes one `--meta "A:b#C:d"`; ossutil 2.x takes separate header
# flags (--content-encoding, --cache-control). Detected rather than assumed,
# because guessing wrong is not a loud failure: the object can upload perfectly
# with the header simply absent, which is precisely the silent breakage this
# script exists to prevent. verify-oss.sh at the end is the backstop.
OSSUTIL_MAJOR="$("$OSSUTIL" --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 | cut -d. -f1)"
OSSUTIL_MAJOR="${OSSUTIL_MAJOR:-1}"
echo "ossutil major version: $OSSUTIL_MAJOR"

# Fills the META array for the flavour in use. $1 Cache-Control,
# $2 Content-Encoding (optional), $3 Content-Type (optional).
META=()
set_meta() {
  META=()
  if [ "$OSSUTIL_MAJOR" -ge 2 ]; then
    META+=(--cache-control "$1")
    if [ -n "${2:-}" ]; then META+=(--content-encoding "$2"); fi
    if [ -n "${3:-}" ]; then META+=(--content-type "$3"); fi
  else
    local m="Cache-Control:$1"
    if [ -n "${2:-}" ]; then m="$m#Content-Encoding:$2"; fi
    if [ -n "${3:-}" ]; then m="$m#Content-Type:$3"; fi
    META+=(--meta "$m")
  fi
}

echo "=== 1/3  Fingerprinted assets (immutable) ==="
# Every filename under _next/static contains a content hash, so a changed file is
# a changed URL and this can never serve a stale one.
set_meta "public, max-age=31536000, immutable"
"$OSSUTIL" cp -r out/_next/static/ "$DEST/_next/static/" "${COMMON[@]}" "${META[@]}"

echo "=== 2/3  Geometry (immutable + Content-Encoding) ==="
# The header the whole hero depends on. Set at upload rather than patched after,
# so there is no window where the object exists without it.
for f in out/models/*.br; do
  name="$(basename "$f")"
  set_meta "public, max-age=31536000, immutable" "br" "application/octet-stream"
  "$OSSUTIL" cp "$f" "$DEST/models/$name" "${COMMON[@]}" "${META[@]}"
done

echo "=== 3/3  Everything else (revalidate) ==="
# HTML, robots.txt, sitemap.xml, the product JPEGs. These share URLs across
# deploys, so they must revalidate or a visitor keeps yesterday's page forever.
set_meta "public, max-age=0, must-revalidate"
"$OSSUTIL" cp -r out/ "$DEST/" "${COMMON[@]}" "${META[@]}" \
  --exclude "_next/static/*" --exclude "models/*"

echo
echo "=== Deployed. Verifying the headers actually took ==="
./scripts/verify-oss.sh
