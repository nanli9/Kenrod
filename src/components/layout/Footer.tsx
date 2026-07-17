import { useTranslations } from 'next-intl';
import { SealChop } from './Header';

export default function Footer() {
  const t = useTranslations('footer');

  return (
    <footer className="bg-lacquer border-t border-brass/15 text-bone">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-14 md:py-16">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-10 mb-12">
          {/* Brand */}
          <div className="md:col-span-6">
            <div className="flex items-center gap-3 mb-4">
              <span className="font-display text-2xl font-bold tracking-[0.18em] text-ivory">
                KENROD
              </span>
              <SealChop />
            </div>
            <p className="text-sm max-w-xs leading-relaxed text-bone-dim">{t('tagline')}</p>
          </div>

          {/* Shop Links */}
          <div className="md:col-span-3">
            <h4 className="font-mono text-[10px] uppercase tracking-[0.3em] text-brass/80 mb-5">
              {t('shop')}
            </h4>
            <div className="space-y-3">
              {/* TODO: Replace # with actual store URLs */}
              <a href="#" className="block text-sm hover:text-jade-bright transition-colors">
                Shopify
              </a>
              <a href="#" className="block text-sm hover:text-jade-bright transition-colors">
                Amazon
              </a>
            </div>
          </div>

          {/* Social Links */}
          <div className="md:col-span-3">
            <h4 className="font-mono text-[10px] uppercase tracking-[0.3em] text-brass/80 mb-5">
              {t('social')}
            </h4>
            <div className="space-y-3">
              {/* TODO: Replace # with actual social media URLs */}
              <a href="#" className="block text-sm hover:text-jade-bright transition-colors">
                WeChat
              </a>
              <a href="#" className="block text-sm hover:text-jade-bright transition-colors">
                Instagram
              </a>
              <a href="#" className="block text-sm hover:text-jade-bright transition-colors">
                LinkedIn
              </a>
            </div>
          </div>
        </div>

        <div className="border-t border-brass/10 pt-6 flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="font-mono text-[11px] text-bone-dim tracking-wider">
            &copy; {new Date().getFullYear()} {t('copyright')}
          </p>
          <p className="font-mono text-[11px] text-bone-dim tracking-wider">{t('address')}</p>
        </div>
      </div>
    </footer>
  );
}
