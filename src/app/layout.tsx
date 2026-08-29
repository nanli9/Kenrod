import type { Metadata, Viewport } from 'next';
import { siteUrl } from '@/lib/siteUrl';

export const metadata: Metadata = {
  // The origin every relative URL in this metadata is resolved against. Next
  // needs it to turn an OG image path into the absolute URL a crawler or a chat
  // client can actually fetch; without it those tags are emitted relative and
  // silently ignored by everything that unfurls a link. See src/lib/siteUrl.ts
  // for where the origin comes from on Vercel vs. a custom domain.
  metadataBase: new URL(siteUrl()),
  title: 'Kenrod 国友 — Precision Manufacturing',
  description: 'Kenrod — Precision Engineering, Exceptional Quality',
};

export const viewport: Viewport = {
  themeColor: '#050505',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
