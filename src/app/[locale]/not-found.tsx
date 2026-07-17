import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';

export default function NotFound() {
  const t = useTranslations('common');

  return (
    <section className="py-16 px-4 text-center min-h-[70vh] flex flex-col items-center justify-center bg-void">
      <p className="font-mono text-xs tracking-[0.35em] text-acid uppercase mb-6">
        Error / 404
      </p>
      <h1 className="font-display text-8xl md:text-9xl text-smoke uppercase mb-4">404</h1>
      <p className="text-mute mb-10">{t('not_found')}</p>
      <Link
        href="/"
        className="inline-flex h-11 items-center px-7 rounded-full bg-acid text-void font-mono text-xs uppercase tracking-[0.15em] font-medium hover:bg-smoke transition-colors"
      >
        {t('go_home')}
      </Link>
    </section>
  );
}
