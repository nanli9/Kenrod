# Deploying to Alibaba Cloud OSS (Hong Kong)

The site is a static export served from an object storage bucket. No server, no
container, no runtime. This document is why it is shaped that way and how to put
it somewhere.

## Why Hong Kong

Vercel is not reachable from mainland China without a VPN, which is what started
this. The options were:

- **A server inside mainland China.** Fastest, and legally requires an **ICP备案**
  filing — a Chinese business entity or citizen ID, a real-name-verified domain,
  and roughly 2–3 weeks. Hosts enforce it; there is no way around it.
- **Hong Kong or Singapore.** No ICP filing, not behind the GFW, reachable from
  the mainland without a VPN. Slower than domestic hosting because traffic
  crosses the border, but it works today.

Hong Kong was chosen to avoid the filing. If Kenrod later files for ICP, the same
`out/` directory uploads to a mainland bucket unchanged — only the endpoint and
the CDN in front of it differ.

**The cross-border latency is real.** The hero blocks on a 4.13 MB download. It
will work; it will not feel like it does on a laptop next to the bucket. This is
the strongest argument for eventually doing the ICP filing and putting a mainland
CDN in front.

## What became static, and what replaced it

Three things could not survive `output: 'export'`:

| Deleted | What it did | What does it now |
|---|---|---|
| `src/middleware.ts` | next-intl read `Accept-Language`, redirected `/` | inline script in `src/app/page.tsx` reads `navigator.language` |
| `src/app/hero-model/[file]/route.ts` | negotiated + set `Content-Encoding` | `Content-Encoding: br` object metadata, set by `deploy-oss.sh` |
| `next/image` optimiser | resized JPEGs on request | `images.unoptimized` — the six product JPEGs ship as authored |

The locale redirect is a small **improvement**: it honours `zh-*` browsers, so a
mainland visitor lands on `/zh/` instead of the English page.

Serving the geometry off the bucket is a **large** improvement. Through the
Vercel route the hero pulled **5,548,975 bytes**, because Vercel's edge
re-compressed the response at its own lower quality. Straight off a bucket it is
the **4,132,280-byte** q11 file — 1.42 MB less, and no function in the path.

## ⚠️ This branch breaks the pm2 and Docker deploys

`output: 'export'` means `next start` refuses to run and `.next/standalone` is
never produced. So **`scripts/deploy.sh` and `docker/Dockerfile` no longer work**.
That is the deliberate cost of "no server"; nothing here needs one. If you ever
want that path back, it is `output: 'export'` and `trailingSlash` out of
`next.config.ts` and the route restored from git history — the route's own
comments explain why it existed and are worth reading first.

## One-time setup

1. **Buy a domain.** Not optional: Alibaba's default OSS endpoints force a
   download instead of rendering HTML, so a bound custom domain is what makes
   this a website. ~$10/yr. A `.cn` also suits a later ICP move.
2. **Create the bucket** in region `oss-cn-hongkong`, ACL **public read**.
3. **Static Pages** on the bucket: index document `index.html`, error document
   `404.html`.
4. **Bind the domain** (Transmission → Domain Names) and add the CNAME it gives
   you. Enable HTTPS with a certificate.
5. **Install and configure ossutil**: `ossutil config`.

## Every deploy

```bash
export OSS_BUCKET=kenrod-site
export NEXT_PUBLIC_SITE_URL=https://your-domain.com
./scripts/deploy-oss.sh
```

`NEXT_PUBLIC_SITE_URL` is required because the origin is **compiled into**
`robots.txt` and `sitemap.xml` at build time. A bucket cannot compute it later,
so a wrong value here ships a sitemap advertising the wrong host.

The script builds, strips `.DS_Store` and the unused `.gz`/raw `.bin` copies,
uploads in three passes with the right `Cache-Control` per class, and then runs
`verify-oss.sh` on the live URL.

## Why verification is not optional

If `Content-Encoding: br` is missing from the geometry objects, **every page
still returns 200**, the bucket listing looks correct, and the file is the right
size — but the browser hands `parseCadLayers` 4 MB of compressed noise, the
magic-number check fails, and the hero renders blank with nothing useful in the
console. A drag-and-drop upload through the OSS console sets no metadata and
produces exactly this.

`./scripts/verify-oss.sh` checks the header, the wire size, and that the bytes
inflate to 7,628,072. Run it after any manual change to the bucket.

## When the geometry changes

Re-running the Blender exporter changes the binaries. The model URLs are served
`immutable` for a year and busted only by `MODEL_REV`, so you must bump it in
`src/lib/modelRev.ts` and paste the two hashes `precompress.mjs` prints. The
script **fails the build** if they disagree, so this is enforced rather than
remembered.
