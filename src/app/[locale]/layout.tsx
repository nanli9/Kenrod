import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { Inter, Anton, IBM_Plex_Mono, Noto_Sans_SC } from 'next/font/google';
import { routing } from '@/i18n/routing';
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
