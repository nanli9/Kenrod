'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import LanguageSwitcher from './LanguageSwitcher';

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
    <header
      className={`fixed top-0 z-50 w-full text-white transition-all duration-300 ${
        scrolled || mobileOpen
          ? 'bg-ink/75 backdrop-blur-xl border-b border-white/[0.06]'
          : 'bg-transparent border-b border-transparent'
      }`}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <a
            href="#"
            onClick={(e) => scrollTo(e, '#')}
            className="flex items-baseline gap-2.5 group"
          >
            <span className="font-display text-lg font-bold tracking-[0.25em]">
              KENROD
            </span>
            <span className="font-mono text-[10px] text-steel-dim tracking-widest group-hover:text-accent/80 transition-colors">
              国友®
            </span>
          </a>

          <nav className="hidden md:flex items-center gap-9">
            {navItems.map((item) => (
              <a
                key={item.href}
                href={item.href}
                onClick={(e) => scrollTo(e, item.href)}
                className="group font-mono text-[11px] uppercase tracking-[0.25em] text-steel-mid hover:text-white transition-colors"
              >
                <span className="text-accent/60 mr-1.5 group-hover:text-accent transition-colors">
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
              className="hidden sm:inline-flex items-center h-8 px-4 bg-white text-ink text-xs font-medium tracking-wide rounded-full hover:bg-steel-light transition-colors"
            >
              {t('contact')}
            </a>
            <button
              onClick={() => setMobileOpen(!mobileOpen)}
              className="md:hidden p-2 text-steel-mid hover:text-white"
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
        <nav className="md:hidden border-t border-white/[0.06] bg-ink/95 backdrop-blur-xl">
          <div className="px-4 py-4 space-y-1">
            {navItems.map((item) => (
              <a
                key={item.href}
                href={item.href}
                onClick={(e) => scrollTo(e, item.href)}
                className="flex items-center gap-3 px-3 py-3 font-mono text-xs uppercase tracking-[0.25em] text-steel-mid hover:text-white hover:bg-white/5 transition-colors"
              >
                <span className="text-accent/60">{item.index}</span>
                {item.label}
              </a>
            ))}
          </div>
        </nav>
      )}
    </header>
  );
}
