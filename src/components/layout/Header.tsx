'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import LanguageSwitcher from './LanguageSwitcher';

// The 国友 chop — the only vermilion in the whole system.
export function SealChop({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-flex flex-col items-center justify-center w-[22px] h-[22px] rounded-[5px] bg-seal text-paper font-display font-bold text-[9px] leading-[1.05] select-none ${className}`}
    >
      <span>国</span>
      <span>友</span>
    </span>
  );
}

export default function Header() {
  const t = useTranslations('nav');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 32);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const navItems = [
    { href: '#products', index: '01', label: t('products') },
    { href: '#about', index: '02', label: t('about') },
    { href: '#contact', index: '03', label: t('contact') },
  ];

  const scrollTo = (e: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    e.preventDefault();
    setMobileOpen(false);
    if (href === '#') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    const el = document.querySelector(href);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
    }
  };

  return (
    // Stays lacquer-dark over both dark and paper sections — a museum plaque.
    <header
      className={`fixed top-0 z-50 w-full text-ivory transition-all duration-300 ${
        scrolled || mobileOpen
          ? 'bg-lacquer/80 backdrop-blur-xl border-b border-brass/15'
          : 'bg-transparent border-b border-transparent'
      }`}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <a
            href="#"
            onClick={(e) => scrollTo(e, '#')}
            className="flex items-center gap-3 group"
          >
            <span className="font-display text-xl font-bold tracking-[0.18em]">
              KENROD
            </span>
            <SealChop className="opacity-90 group-hover:opacity-100 transition-opacity" />
          </a>

          <nav className="hidden md:flex items-center gap-9">
            {navItems.map((item) => (
              <a
                key={item.href}
                href={item.href}
                onClick={(e) => scrollTo(e, item.href)}
                className="group font-mono text-[11px] uppercase tracking-[0.25em] text-bone hover:text-ivory transition-colors"
              >
                <span className="text-brass/70 mr-1.5 group-hover:text-brass transition-colors">
                  {item.index}
                </span>
                {item.label}
              </a>
            ))}
          </nav>

          <div className="flex items-center gap-3">
            <LanguageSwitcher />
            <a
              href="#contact"
              onClick={(e) => scrollTo(e, '#contact')}
              className="hidden sm:inline-flex items-center h-8 px-4 bg-jade text-white text-xs font-medium tracking-wide rounded-full hover:bg-jade-bright hover:text-lacquer transition-colors"
            >
              {t('contact')}
            </a>
            <button
              onClick={() => setMobileOpen(!mobileOpen)}
              className="md:hidden p-2 text-bone hover:text-ivory"
              aria-label="Toggle menu"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {mobileOpen ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 7h16M4 12h16M4 17h16" />
                )}
              </svg>
            </button>
          </div>
        </div>
      </div>

      {mobileOpen && (
        <nav className="md:hidden border-t border-brass/15 bg-lacquer/95 backdrop-blur-xl">
          <div className="px-4 py-4 space-y-1">
            {navItems.map((item) => (
              <a
                key={item.href}
                href={item.href}
                onClick={(e) => scrollTo(e, item.href)}
                className="flex items-center gap-3 px-3 py-3 font-mono text-xs uppercase tracking-[0.25em] text-bone hover:text-ivory hover:bg-white/5 transition-colors"
              >
                <span className="text-brass/70">{item.index}</span>
                {item.label}
              </a>
            ))}
          </div>
        </nav>
      )}
    </header>
  );
}
