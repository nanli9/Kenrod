import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = {
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
