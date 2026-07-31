import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig = {
  async headers() {
    return [
      {
        // The hero's model binaries are ~17 MB and they change only when their
        // build script is re-run, so a returning visitor should never fetch them
        // twice. Cache-busting is by the `?v=` stamp the URLs carry (MODEL_REV in
        // ScrollScene.tsx) rather than by revalidation — which is what makes
        // `immutable` safe here, and also what makes bumping MODEL_REV mandatory
        // after any rebuild. Without the stamp this header would strand people on
        // stale geometry for a year.
        source: '/models/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
