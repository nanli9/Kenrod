import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';

export default function NotFound() {
  const t = useTranslations('common');

  return (
    <section className="py-16 px-4 text-center min-h-[70vh] flex flex-col items-center justify-center bg-ink">
      <p className="font-mono text-xs tracking-[0.35em] text-accent/80 uppercase mb-6">
        Error / 404
      </p>
      <h1 className="font-display text-6xl md:text-7xl font-bold text-white mb-4">404</h1>
      <p className="text-steel-mid mb-10">{t('not_found')}</p>
      <Link
        href="/"
        className="inline-flex h-11 items-center px-7 rounded-full bg-white text-ink text-sm font-medium hover:bg-steel-light transition-colors"
      >
        {t('go_home')}
      </Link>
    </section>
  );
}
