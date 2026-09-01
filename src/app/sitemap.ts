import type { MetadataRoute } from 'next';
import { routing } from '@/i18n/routing';
import { siteUrl } from '@/lib/siteUrl';

// Generated into a static /sitemap.xml at build time.
//
// The site is one page in two locales, so this is two entries — but the two are
// translations of each other, not separate content, and saying so is the whole
// point of listing them. Each entry carries the full `languages` map, which Next
// emits as reciprocal xhtml:link rel="alternate" hreflang tags. Without them a
// crawler is entitled to read /en and /zh as duplicate pages and pick one; with
// them it serves the right one per visitor. The map is deliberately identical on
// both entries — hreflang annotations must be mutual, and an entry that omits
// itself is ignored.
//
// `x-default` points at the locale the bare `/` falls back to (src/app/page.tsx),
// so the sitemap and the redirect cannot disagree about where an unmatched
// visitor lands.
//
// Every URL carries a trailing slash to match `trailingSlash: true` in
// next.config.ts. Object storage resolves `/en/` to `en/index.html` and 404s on
// `/en`, so a sitemap without the slash would advertise URLs the bucket cannot
// serve.
// Required by `output: 'export'`. This file reads process.env through siteUrl(),
// which is enough for Next to suspect it might vary per request and refuse to
// export it — the build fails outright rather than silently omitting the file.
// The origin is baked in at build time, which is exactly the intent: a bucket
// cannot compute it later.
export const dynamic = 'force-static';

export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();

  const languages: Record<string, string> = Object.fromEntries(
    routing.locales.map((locale) => [locale, `${base}/${locale}/`]),
  );
  languages['x-default'] = `${base}/${routing.defaultLocale}/`;

  return routing.locales.map((locale) => ({
    url: `${base}/${locale}/`,
    lastModified: new Date(),
    changeFrequency: 'monthly' as const,
    priority: locale === routing.defaultLocale ? 1 : 0.8,
    alternates: { languages },
  }));
}
