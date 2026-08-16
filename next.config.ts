import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig = {
  async headers() {
    return [
      {
        // The hero's model binaries are 7.3 MB together (it was ~17 MB until the
        // teardown moved off the 3DGS captures onto the CAD) and they change only
        // when their build script is re-run, so a returning visitor should never
        // fetch them twice. Cache-busting is by the `?v=` stamp the URLs carry
        // (MODEL_REV in src/lib/modelRev.ts) rather than by revalidation — which
        // is what makes `immutable` safe here, and also what makes bumping
        // MODEL_REV mandatory after any rebuild. Without the stamp this header
        // would strand people on stale geometry for a year.
        //
        // The site does not actually fetch these URLs any more. Next's bundled
        // compression middleware skips application/octet-stream, so anything
        // served from public/ went over the wire raw — 7.27 MB instead of 3.94 —
        // and public/ is handled BEFORE the app router, so the path could not be
        // taken over in place. The hero fetches the same bytes through
        // src/app/hero-model/[file]/route.ts, which sets both this header and a
        // Content-Encoding. This rule stays for anything that still hits the
        // folder directly, including a stale preload from a cached document.
        source: '/models/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
