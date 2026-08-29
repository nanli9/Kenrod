import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/siteUrl';

// Generated into a static /robots.txt at build time.
//
// /hero-model/ is disallowed on purpose. It is the route that serves the 3.9 MB
// brotli geometry (src/app/hero-model/[file]/route.ts), and there is nothing in
// a vertex block for a crawler to index — only bandwidth to spend. Blocking it
// costs the site nothing: the page that needs those bytes fetches them from the
// browser, which does not consult robots.txt.
//
// public/models/ is left alone. Those URLs are unlinked from any page, so
// nothing crawls to them, and naming them here would be the one thing that
// advertises 7.3 MB of uncompressed binaries to anyone reading this file.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: '/hero-model/',
    },
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
