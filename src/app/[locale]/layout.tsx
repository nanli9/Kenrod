import { NextIntlClientProvider } from 'next-intl';
import { getMessages, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { Inter, Anton, IBM_Plex_Mono, Noto_Sans_SC } from 'next/font/google';
import { routing } from '@/i18n/routing';
import { CAD_URL, CAD_INDEX_URL } from '@/lib/modelRev';
import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';
import Grain from '@/components/motion/Grain';
import Cursor from '@/components/motion/Cursor';
import '../globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

// Ultra-condensed poster face for the kinetic display type. CJK glyphs fall
// through to heavy system sans (Heiti/PingFang).
const anton = Anton({
  weight: '400',
  subsets: ['latin'],
  variable: '--font-anton',
  display: 'swap',
});

// Black-weight hanzi for the particle hero word. Google slices CJK faces by
// unicode-range, so a visitor only downloads the small slices containing the
// glyphs actually rendered (the hero's 制造) — not the whole face.
const notoHei = Noto_Sans_SC({
  weight: '900',
  variable: '--font-hei',
  display: 'swap',
  preload: false,
});

// Mid-weight hanzi for the lockup's small secondary line (制造): the 900
// face's inter-stroke gaps clog with particle grain at that size, exactly
// like Anton's counters did for the latin. Same unicode-range slicing —
// visitors only download the slices for glyphs actually drawn.
const notoHeiMid = Noto_Sans_SC({
  weight: '500',
  variable: '--font-hei-mid',
  display: 'swap',
  preload: false,
});

const plexMono = IBM_Plex_Mono({
  weight: ['400', '500'],
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

// Prerender both locales at build time instead of rendering them per request.
//
// Without this the [locale] segment has no known set of values, so Next has to
// treat every URL under it as dynamic and run the whole tree — fonts, layout,
// the client bundle's HTML shell — on each visit. Nothing on this page varies by
// request: it is one marketing page in two languages, both fully determined at
// build. Listing them here turns /en and /zh into static HTML the CDN answers
// directly, which is also what makes the hero's two <link rel="preload"> tags
// worth having, since they now ship in a document that needs no server round
// trip to produce.
//
// Sourced from routing.locales rather than a literal, so adding a third locale
// to src/i18n/routing.ts cannot leave a page behind that silently reverts to
// dynamic rendering.
export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  if (!routing.locales.includes(locale as 'en' | 'zh')) {
    notFound();
  }

  // Hand next-intl the locale explicitly. This is not a formality and it is not
  // optional: without it getMessages() resolves the locale by reading request
  // headers, and a single headers() read anywhere in the tree opts the entire
  // segment back out of static rendering — generateStaticParams above would go
  // on producing both pages while every visit still paid for a server render.
  // The failure mode is a build that looks correct and a site that is not, which
  // is why it is asserted in the build output rather than trusted (see the ○/●
  // markers for /[locale] in `npm run build`).
  //
  // Must run before any other next-intl server call in this component.
  setRequestLocale(locale);

  const messages = await getMessages();

  return (
    // suppressHydrationWarning covers only this element's own attributes, not its
    // descendants — it silences extension-injected attrs (Dark Reader et al.) on
    // <html> without hiding real hydration bugs deeper in the tree.
    <html
      lang={locale}
      suppressHydrationWarning
      className={`${inter.variable} ${anton.variable} ${plexMono.variable} ${notoHei.variable} ${notoHeiMid.variable}`}
    >
      <head>
        {/* Start the hero's geometry during HTML parse.
            The scene fetches these from a useEffect in a 'use client' component,
            so without this the transfer cannot begin until the JS bundle has
            downloaded, parsed and hydrated — typically 1-3 s of a cold load, in
            front of the one asset the hero is blank without. The document
            already preloads four woff2 faces and did not preload this.
            crossOrigin is REQUIRED and is not decoration: `as="fetch"` only
            matches a later request whose CORS and credentials modes agree, and
            "anonymous" is what a bare fetch(url) uses. Get it wrong and the
            preload is discarded and the 4 MB downloads twice — which is worse
            than not preloading at all. Verify in the network panel that the
            second request is served from the preload cache. */}
        <link rel="preload" href={CAD_URL} as="fetch" crossOrigin="anonymous" />
        <link rel="preload" href={CAD_INDEX_URL} as="fetch" crossOrigin="anonymous" />
      </head>
      <body className="min-h-screen flex flex-col bg-void text-smoke font-sans">
        <NextIntlClientProvider messages={messages}>
          <Header />
          <main className="flex-1">{children}</main>
          <Footer />
          <Grain />
          <Cursor />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
