#!/bin/bash
# Prove a deployment actually works, rather than merely exists.
#
# The failure this exists for is silent. If Content-Encoding:br is missing from
# the geometry objects, every page still returns 200, the bucket listing looks
# right, the file is the correct size — and the hero is blank, because
# parseCadLayers was handed compressed bytes and rejected them. Nothing short of
# opening the site in a browser catches that, so this does it from the shell.
set -uo pipefail
cd "$(dirname "$0")/.."

BASE="${NEXT_PUBLIC_SITE_URL:?set NEXT_PUBLIC_SITE_URL, e.g. https://kenrod.com}"
BASE="${BASE%/}"
fail=0
ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=1; }

echo "Verifying $BASE"

echo "- pages"
for p in "/" "/en/" "/zh/" "/robots.txt" "/sitemap.xml"; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE$p" || echo 000)
  [ "$code" = "200" ] && ok "$p -> 200" || bad "$p -> $code"
done

echo "- sitemap points at this domain, not localhost"
if curl -sS "$BASE/sitemap.xml" | grep -q "$BASE"; then
  ok "sitemap origin"
else
  bad "sitemap does not contain $BASE — built with the wrong NEXT_PUBLIC_SITE_URL"
fi

echo "- geometry: the header the hero depends on"
for pair in "cad-layers.bin.br:4132280:7628072" "cad-layers-index.bin.br:12418:27948"; do
  name="${pair%%:*}"; rest="${pair#*:}"; want_enc="${rest%%:*}"; want_raw="${rest##*:}"

  enc=$(curl -sSI "$BASE/models/$name" | tr -d '\r' | awk 'tolower($1)=="content-encoding:"{print tolower($2)}')
  [ "$enc" = "br" ] && ok "$name Content-Encoding: br" \
                    || bad "$name Content-Encoding is '${enc:-<absent>}' — the hero will render blank"

  # Transferred bytes: should be the q11 file, not a re-compression of it.
  got=$(curl -sS -H 'Accept-Encoding: br' -o /dev/null -w '%{size_download}' "$BASE/models/$name")
  [ "$got" = "$want_enc" ] && ok "$name wire size $got" \
                           || bad "$name wire size $got, expected $want_enc"

  # And the end-to-end check: what a browser ends up holding.
  #
  # Decompressed with node rather than `curl --compressed` because the curl
  # shipped with macOS is built without brotli — it answers "Unrecognized content
  # encoding type" and reports zero bytes, which looks exactly like a broken
  # deployment. node's zlib always has brotli, and this repo cannot be built
  # without node anyway. It is also the stricter test: it proves the bytes parse
  # as brotli and inflate to the expected length, which is precisely what the
  # browser will do before handing them to parseCadLayers.
  tmp=$(mktemp)
  curl -sS -H 'Accept-Encoding: br' "$BASE/models/$name" -o "$tmp"
  got_raw=$(node -e 'const z=require("zlib"),f=require("fs");try{process.stdout.write(String(z.brotliDecompressSync(f.readFileSync(process.argv[1])).length))}catch(e){process.stdout.write("0")}' "$tmp")
  rm -f "$tmp"
  [ "$got_raw" = "$want_raw" ] && ok "$name inflates to $got_raw" \
                              || bad "$name inflates to $got_raw, expected $want_raw"
done

echo
[ "$fail" = 0 ] && echo "All checks passed." || { echo "Some checks FAILED (see above)."; exit 1; }
