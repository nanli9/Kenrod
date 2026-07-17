import { useTranslations } from 'next-intl';

export default function Footer() {
  const t = useTranslations('footer');

  return (
    <footer className="bg-void border-t border-white/10 text-mute overflow-hidden">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-14 md:pt-16">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-10 mb-14">
          {/* Brand */}
          <div className="md:col-span-6">
            <div className="flex items-baseline gap-2.5 mb-4">
              <span className="font-display text-2xl tracking-[0.14em] text-smoke">KENROD</span>
              <span className="font-mono text-[10px] text-acid tracking-widest">国友®</span>
            </div>
            <p className="text-sm max-w-xs leading-relaxed">{t('tagline')}</p>
          </div>

          {/* Shop Links */}
          <div className="md:col-span-3">
            <h4 className="font-mono text-[10px] uppercase tracking-[0.3em] text-smoke/50 mb-5">
              {t('shop')}
            </h4>
            <div className="space-y-3">
              {/* TODO: Replace # with actual store URLs */}
              <a href="#" className="block text-sm hover:text-acid transition-colors">
                Shopify
              </a>
              <a href="#" className="block text-sm hover:text-acid transition-colors">
                Amazon
              </a>
            </div>
          </div>

          {/* Social Links */}
          <div className="md:col-span-3">
            <h4 className="font-mono text-[10px] uppercase tracking-[0.3em] text-smoke/50 mb-5">
              {t('social')}
            </h4>
            <div className="space-y-3">
              {/* TODO: Replace # with actual social media URLs */}
              <a href="#" className="block text-sm hover:text-acid transition-colors">
                WeChat
              </a>
              <a href="#" className="block text-sm hover:text-acid transition-colors">
                Instagram
              </a>
              <a href="#" className="block text-sm hover:text-acid transition-colors">
                LinkedIn
              </a>
            </div>
          </div>
        </div>

        <div className="border-t border-white/10 pt-6 pb-8 flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="font-mono text-[11px] tracking-wider">
            &copy; {new Date().getFullYear()} {t('copyright')}
          </p>
          <p className="font-mono text-[11px] tracking-wider">{t('address')}</p>
        </div>
      </div>

      {/* Giant outline sign-off */}
      <div aria-hidden className="select-none pointer-events-none px-2 pb-2">
        <p className="font-display text-outline uppercase leading-[0.85] tracking-tight text-[16vw] whitespace-nowrap text-center">
          KENROD 国友
        </p>
      </div>
    </footer>
  );
}
