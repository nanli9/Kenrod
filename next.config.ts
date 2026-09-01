import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  // A directory of files, not a running server. `next build` now writes out/ and
  // nothing has to execute to serve it, which is what lets this sit in an object
  // storage bucket in Hong Kong — reachable from the mainland without a VPN and
  // without the ICP filing that any server INSIDE China would legally require.
  //
  // Everything removed to get here is listed in docs/DEPLOY-OSS.md. The short
  // version: there is no request to run code against any more, so middleware and
  // route handlers are gone, and the two things they did are now done by the
  // bucket's object metadata and by a script in the browser.
  output: 'export',

  // Emit out/en/index.html rather than out/en.html.
  //
  // Object storage has no extension-less resolution — it looks up the exact key
  // and 404s. `/en` would find no object named `en`; `/en/` finds `en/index.html`
  // through the bucket's index-document setting. Without this the site is a
  // directory of files that only resolve if you type the .html yourself.
  trailingSlash: true,

  images: {
    // next/image's optimiser is a server. There isn't one; the six product JPEGs
    // in public/images/products ship as authored. They are already 512px and
    // 2.3 MB for the set, which is why this is acceptable rather than merely
    // unavoidable — but it does mean a resize is now a job for the source files,
    // not a query parameter.
    unoptimized: true,
  },

  // NOTE: the `headers()` block that used to live here is gone, and its job did
  // not disappear with it. It set `Cache-Control: immutable` on /models/*, which
  // is what makes MODEL_REV the only thing that can invalidate a returning
  // visitor's copy of the geometry. `output: 'export'` cannot apply headers —
  // there is no server to apply them — so that header, and the Content-Encoding
  // the hero now depends on, are set as object metadata at upload time by
  // scripts/deploy-oss.sh. If that script is bypassed, both are silently absent.
};

export default withNextIntl(nextConfig);
