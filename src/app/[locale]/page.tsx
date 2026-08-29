import { setRequestLocale } from 'next-intl/server';
import HomeClient from '@/components/HomeClient';

// The locale has to be set here as well as in the layout, and this is the part
// that is easy to get wrong. A layout and the page inside it are rendered as
// separate units, so the layout calling setRequestLocale does not cover the
// page; if the page reaches for request headers on its own, the route goes
// dynamic no matter how static the layout is. Calling it in both is what next-intl
// requires for a statically rendered segment.
//
// This is also why the component now takes `params` at all. It rendered fine
// without them — HomeClient is a client component that reads its copy from the
// NextIntlClientProvider in the layout — but "renders fine" was exactly the
// symptom: the page was being server-rendered on every request to produce
// identical output.
export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  return <HomeClient />;
}
