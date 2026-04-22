import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';

export default function NotFound() {
  const t = useTranslations('common');

  return (
    <section className="py-16 px-4 text-center min-h-[60vh] flex flex-col items-center justify-center">
      <h1 className="text-6xl font-bold text-gray-300 mb-4">404</h1>
      <p className="text-xl text-gray-600 mb-8">{t('not_found')}</p>
      <Link
        href="/"
        className="inline-block bg-accent text-white px-6 py-3 rounded-lg font-medium hover:bg-red-600 transition-colors"
      >
        {t('go_home')}
      </Link>
    </section>
  );
}
