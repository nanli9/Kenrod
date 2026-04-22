import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import Section from '@/components/ui/Section';

export default function NotFound() {
  const t = useTranslations('common');

  return (
    <Section className="text-center">
      <h1 className="text-6xl font-bold text-gray-300 mb-4">404</h1>
      <p className="text-xl text-gray-600 mb-8">{t('not_found')}</p>
      <Link
        href="/"
        className="inline-block bg-accent text-white px-6 py-3 rounded-lg font-medium hover:bg-red-600 transition-colors"
      >
        {t('go_home')}
      </Link>
    </Section>
  );
}
