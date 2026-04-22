import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Kenrod Manufacturing',
  description: 'Kenrod - Precision Engineering, Exceptional Quality',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
