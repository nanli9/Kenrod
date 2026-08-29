// The site's absolute origin, for the three places Next is required to emit a
// full URL and cannot infer one: robots.txt's `Sitemap:` line, every <loc> in
// sitemap.xml, and `metadataBase` (which is what turns a relative OG image path
// into the absolute URL a crawler will actually fetch). A relative path is
// invalid in all three, so something has to name the deployment.
//
// The order below is deliberate.
//
// NEXT_PUBLIC_SITE_URL wins because it is the explicit answer — it is what a
// custom domain sets, and a custom domain is the only thing that knows its own
// name. It is already declared in .env.example and was, until now, read by
// nothing.
//
// VERCEL_PROJECT_PRODUCTION_URL is the fallback because Vercel sets it
// automatically and it is the PRODUCTION host, so importing this repo with zero
// environment configuration still produces a correct sitemap instead of one
// advertising localhost to every crawler that reads it. It arrives as a bare
// host with no scheme, hence the https:// below.
//
// It is deliberately NOT VERCEL_URL. That one is the per-deployment host — a new
// random subdomain for every push, including previews — and using it would stamp
// a throwaway hostname into the canonical URLs of a production build. The
// difference is invisible locally and wrong forever in search results.
export function siteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  if (explicit) return explicit.replace(/\/+$/, '');

  const production = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (production) return `https://${production}`;

  return 'http://localhost:3000';
}
