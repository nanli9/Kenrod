import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/siteUrl';

// Generated into a static /robots.txt at build time.
//
// /models/ is disallowed because that is now where the geometry is fetched from
// directly — the /hero-model/ route this used to name was deleted when the site
// became a static export. Same reasoning as before: there is nothing in a vertex
// block for a crawler to index, only bandwidth to spend, and the browser that
// needs those bytes does not consult robots.txt.
//
// The tradeoff is deliberate. A renderer that obeys this (Googlebot does) will
// draw the page without its hero. That is the correct trade for a decorative
// WebGL canvas whose absence costs no content: every word on the page is in the
// HTML already, and the alternative is inviting crawlers to pull 4 MB each.
// Required by `output: 'export'`. This file reads process.env through siteUrl(),
// which is enough for Next to suspect it might vary per request and refuse to
// export it — the build fails outright rather than silently omitting the file.
// The origin is baked in at build time, which is exactly the intent: a bucket
// cannot compute it later.
export const dynamic = 'force-static';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: '/models/',
    },
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
