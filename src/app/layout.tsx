import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = {
  title: 'Kenrod 国友 — Precision Manufacturing',
  description: 'Kenrod — Precision Engineering, Exceptional Quality',
};

export const viewport: Viewport = {
  themeColor: '#04060b',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
