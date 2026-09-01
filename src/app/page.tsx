import { routing } from '@/i18n/routing';

// What src/middleware.ts used to do, minus the server.
//
// next-intl's middleware read Accept-Language and redirected / to the best
// matching locale. `output: 'export'` has no request to read a header from, so
// the negotiation moves into the document: this page is a static shell whose only
// job is to bounce the visitor to /en/ or /zh/.
//
// It is deliberately NOT a plain redirect to the default locale. Half this site's
// audience is in mainland China, and sending a zh-CN browser to the English page
// and making them find the language switcher is a worse first impression than the
// redirect costs. navigator.language is the client-side equivalent of the header
// the middleware used to read.
//
// The script is inline and synchronous in <head> on purpose. A redirect that
// waits for hydration would paint the empty shell first, and location.replace —
// not href — so the bounce leaves no history entry to trap the back button on.
const REDIRECT = `(function(){try{
var l=(navigator.languages&&navigator.languages[0])||navigator.language||'';
var t=/^zh\\b/i.test(l)?'/zh/':'/en/';
location.replace(t);
}catch(e){location.replace('/en/');}})();`;

// Rendered as the whole document because the root layout passes children through
// untouched — the <html> element normally comes from [locale]/layout.tsx, which
// this page is not inside.
export default function RootPage() {
  const fallback = `/${routing.defaultLocale}/`;
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        {/* Runs before anything paints. */}
        <script dangerouslySetInnerHTML={{ __html: REDIRECT }} />
        {/* Crawlers and scriptless clients still land somewhere real. */}
        <noscript>
          <meta httpEquiv="refresh" content={`0; url=${fallback}`} />
        </noscript>
        <link rel="canonical" href={fallback} />
      </head>
      <body style={{ margin: 0, background: '#050505' }}>
        <noscript>
          <a href={fallback} style={{ color: '#fff', padding: 16, display: 'block' }}>
            Kenrod — continue to the site
          </a>
        </noscript>
      </body>
    </html>
  );
}
