'use client';

import Image from 'next/image';
import { useTranslations } from 'next-intl';
import ScrollScene from '@/components/three/ScrollScene';
import Marquee from '@/components/motion/Marquee';
import KineticTitle from '@/components/motion/KineticTitle';
import Magnetic from '@/components/motion/Magnetic';
import CountUp from '@/components/motion/CountUp';
import { useInView } from '@/components/motion/useInView';

// 1: blue table in marble room · 5: closed-top dining mode · 3: walnut, top-down
// (2/4/6 are alternates; 2 and 4 carry large baked-in poster text)
const PRODUCT_IMAGES = [
  '/images/products/product-1.jpg',
  '/images/products/product-5.jpg',
  '/images/products/product-3.jpg',
];

function AcidMarquee() {
  return (
    <div className="relative z-10 bg-acid text-void border-y border-void">
      <Marquee className="py-3 md:py-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <span
            key={i}
            className="font-display uppercase text-2xl md:text-4xl tracking-wide mx-6 flex items-center gap-12"
          >
            KENROD <span className="text-lg md:text-2xl">●</span> 国友{' '}
            <span className="text-lg md:text-2xl">●</span> PRECISION ENGINEERING{' '}
            <span className="text-lg md:text-2xl">●</span> EXCEPTIONAL QUALITY{' '}
            <span className="text-lg md:text-2xl">●</span>
          </span>
        ))}
      </Marquee>
    </div>
  );
}

function ProductCard({
  name,
  desc,
  image,
  index,
}: {
  name: string;
  desc: string;
  image: string;
  index: number;
}) {
  const { ref, inView } = useInView<HTMLElement>(0.2);

  return (
    <figure ref={ref} className={`group relative ${inView ? 'is-inview' : ''}`}>
      <span
        aria-hidden
        className="font-display text-outline-dark absolute -top-10 -left-2 text-8xl md:text-9xl leading-none z-0"
      >
        {String(index + 1).padStart(2, '0')}
      </span>
      <div
        className="reveal-img relative z-10 aspect-[3/4] overflow-hidden"
        style={{ transitionDelay: `${index * 120}ms` }}
      >
        <Image
          src={image}
          alt={name}
          fill
          sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
          className="object-cover grayscale group-hover:grayscale-0 group-hover:scale-[1.04] transition-all duration-700"
        />
      </div>
      <figcaption className="relative z-10 mt-5">
        <div className="flex items-baseline justify-between mb-2">
          <span className="font-mono text-[10px] tracking-[0.3em] text-void/50 uppercase">
            UNIT {String(index + 1).padStart(2, '0')}
          </span>
          <span
            aria-hidden
            className="font-mono text-sm text-void/40 group-hover:text-acid-deep group-hover:translate-x-0.5 transition-all"
          >
            ↗
          </span>
        </div>
        <h3 className="font-display uppercase text-2xl md:text-3xl tracking-wide mb-2">
          {name}
        </h3>
        <p className="text-sm leading-relaxed text-void/60 max-w-xs">{desc}</p>
        <span
          aria-hidden
          className="block h-[3px] w-full bg-void mt-5 scale-x-0 group-hover:scale-x-100 origin-left transition-transform duration-500"
        />
      </figcaption>
    </figure>
  );
}

function ProductsSection() {
  const t = useTranslations();
  const items = [1, 2, 3].map((n, i) => ({
    name: t(`products.product${n}_name`),
    desc: t(`products.product${n}_desc`),
    image: PRODUCT_IMAGES[i],
  }));

  return (
    <>
      <AcidMarquee />
      <section
        id="products"
        className="relative scroll-mt-16 py-24 md:py-32 px-4 sm:px-6 lg:px-8 bg-smoke text-void"
      >
        <div className="max-w-7xl mx-auto">
          <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-6 mb-16 md:mb-24">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.35em] text-void/50 mb-4">
                01 / {t('nav.products')}
              </p>
              <KineticTitle
                text={t('products.title')}
                className="font-display uppercase leading-[0.95] tracking-wide text-5xl md:text-8xl"
              />
            </div>
            <p className="max-w-sm font-mono text-xs uppercase tracking-wider leading-relaxed text-void/60 md:text-right">
              {t('products.description')}
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-20">
            {items.map((item, i) => (
              <ProductCard key={i} {...item} index={i} />
            ))}
          </div>

          {/* TODO: Replace # with actual store URLs */}
          <div className="flex flex-wrap justify-center gap-5 mt-20">
            <Magnetic>
              <a
                href="#"
                className="inline-flex h-12 items-center px-8 rounded-full bg-void text-smoke font-mono text-xs uppercase tracking-[0.15em] hover:bg-acid-deep hover:text-void transition-colors"
              >
                {t('products.buy_shopify')}
              </a>
            </Magnetic>
            <Magnetic>
              <a
                href="#"
                className="inline-flex h-12 items-center px-8 rounded-full border border-void/25 text-void font-mono text-xs uppercase tracking-[0.15em] hover:border-void hover:bg-void hover:text-smoke transition-colors"
              >
                {t('products.buy_amazon')}
              </a>
            </Magnetic>
          </div>
        </div>
      </section>
    </>
  );
}

function AboutSection() {
  const t = useTranslations();
  const capabilities = [1, 2, 3].map((n) => ({
    title: t(`about.capability${n}_title`),
    text: t(`about.capability${n}_text`),
  }));
  // TODO: placeholder figures — replace with real company numbers
  const stats = [1, 2, 3, 4].map((n) => ({
    value: t(`about.stat${n}_value`),
    label: t(`about.stat${n}_label`),
  }));

  return (
    <section
      id="about"
      className="relative scroll-mt-16 py-24 md:py-32 px-4 sm:px-6 lg:px-8 bg-void text-smoke border-t border-white/10"
    >
      <div className="max-w-7xl mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-20">
          <div className="lg:sticky lg:top-28 self-start">
            <p className="font-mono text-[11px] uppercase tracking-[0.35em] text-acid mb-4">
              02 / {t('nav.about')}
            </p>
            <KineticTitle
              text={t('about.title')}
              className="font-display uppercase leading-[0.95] tracking-wide text-5xl md:text-7xl mb-6"
            />
            <p className="text-base leading-relaxed text-mute max-w-lg">
              {t('about.description')}
            </p>
          </div>

          <div className="divide-y divide-white/10 border-y border-white/10">
            {capabilities.map((cap, i) => (
              <div key={i} className="group flex gap-6 py-8">
                <span className="font-mono text-xs text-acid pt-1.5">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div>
                  <h3 className="font-display uppercase text-xl md:text-2xl tracking-wide mb-2 group-hover:text-acid transition-colors">
                    {cap.title}
                  </h3>
                  <p className="text-sm leading-relaxed text-mute">{cap.text}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Counter wall */}
        <div className="mt-20 md:mt-24 grid grid-cols-2 lg:grid-cols-4 gap-px bg-white/10 border border-white/10">
          {stats.map((stat, i) => (
            <div key={i} className="bg-void p-7 md:p-9">
              <CountUp
                value={stat.value}
                className="font-display text-5xl md:text-7xl text-acid leading-none block mb-3"
              />
              <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-mute leading-relaxed">
                {stat.label}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const SOCIALS: { label: string; path: string }[] = [
  {
    label: 'WeChat',
    path: 'M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm3.636 4.3c-1.659-.062-3.215.458-4.369 1.416-1.196.992-1.986 2.467-1.986 4.15 0 .401.065.79.162 1.17.642 2.503 3.235 4.347 6.2 4.347.58 0 1.143-.079 1.685-.228a.55.55 0 0 1 .456.063l1.203.703a.222.222 0 0 0 .107.035.187.187 0 0 0 .183-.186c0-.046-.018-.09-.03-.135l-.248-.935a.374.374 0 0 1 .135-.42C20.436 19.756 21.3 18.25 21.3 16.6c0-.4-.065-.79-.162-1.169-.642-2.503-3.235-4.347-6.2-4.347a7.727 7.727 0 0 0-.704.032zm-2.079 2.294c.407 0 .737.336.737.748a.743.743 0 0 1-.737.749.743.743 0 0 1-.737-.749c0-.412.33-.748.737-.748zm3.692 0c.407 0 .736.336.736.748a.743.743 0 0 1-.736.749.743.743 0 0 1-.737-.749c0-.412.33-.748.737-.748z',
  },
  {
    label: 'Instagram',
    path: 'M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z',
  },
  {
    label: 'LinkedIn',
    path: 'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z',
  },
  {
    label: 'Facebook',
    path: 'M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z',
  },
];

function ContactSection() {
  const t = useTranslations('contact');
  const tNav = useTranslations('nav');

  return (
    <section
      id="contact"
      className="relative scroll-mt-16 py-24 md:py-36 px-4 sm:px-6 lg:px-8 bg-void text-smoke border-t border-white/10 overflow-hidden"
    >
      <div className="relative max-w-3xl mx-auto text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.35em] text-acid mb-5">
          03 / {tNav('contact')}
        </p>
        <KineticTitle
          text={t('title')}
          className="font-display uppercase leading-[0.95] tracking-wide text-5xl md:text-8xl mb-6 flex flex-wrap justify-center"
        />
        <p className="text-mute mb-12">{t('description')}</p>

        {/* Email CTA */}
        <div className="flex flex-col items-center gap-5 mb-16">
          <Magnetic strength={0.45}>
            <a
              href={`mailto:${t('email_address')}`}
              className="inline-flex h-14 items-center px-10 rounded-full bg-acid text-void font-mono text-sm font-medium uppercase tracking-[0.15em] hover:bg-smoke transition-colors"
            >
              {t('email_cta')}
            </a>
          </Magnetic>
          <a
            href={`mailto:${t('email_address')}`}
            className="font-mono text-xs text-mute hover:text-acid transition-colors tracking-wider"
          >
            {t('email_address')}
          </a>
        </div>

        {/* Social Media Links */}
        <div className="mb-10">
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-mute mb-5">
            {t('follow_us')}
          </p>
          <div className="flex justify-center gap-3">
            {/* TODO: Replace # with actual social media URLs */}
            {SOCIALS.map((s) => (
              <Magnetic key={s.label} strength={0.5}>
                <a
                  href="#"
                  aria-label={s.label}
                  className="grid place-items-center w-11 h-11 rounded-full border border-white/15 text-mute hover:text-acid hover:border-acid/60 transition-colors"
                >
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                    <path d={s.path} />
                  </svg>
                </a>
              </Magnetic>
            ))}
          </div>
        </div>

        <p className="font-mono text-xs text-mute tracking-wider">{t('address')}</p>
      </div>
    </section>
  );
}

export default function HomeClient() {
  const t = useTranslations();

  const stages = [1, 2, 3].map((n) => ({
    title: t(`scroll_scene.stage${n}_title`),
    text: t(`scroll_scene.stage${n}_text`),
  }));

  return (
    <>
      <ScrollScene
        hero={{
          title: t('hero.title'),
          eyebrow: t('hero.eyebrow'),
          subtitle: t('hero.subtitle'),
          scrollHint: t('hero.scroll_hint'),
          loading: t('hero.loading'),
        }}
        stages={stages}
      />
      <ProductsSection />
      <AboutSection />
      <ContactSection />
    </>
  );
}
