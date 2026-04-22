import { useTranslations } from 'next-intl';
import Section from '@/components/ui/Section';
import Placeholder from '@/components/ui/Placeholder';

export default function HomePage() {
  const t = useTranslations('home');

  return (
    <>
      {/* Hero Section - Full viewport, will become the scroll-driven 3D product reveal */}
      <section className="relative h-screen flex flex-col items-center justify-center bg-primary text-white overflow-hidden">
        <div className="absolute inset-0 flex items-center justify-center">
          <Placeholder
            label="3D Product Scene - Scroll Reveal (like animejs.com)"
            height="h-full"
            className="w-full border-gray-600 bg-gray-800/50"
          />
        </div>
        <div className="relative z-10 text-center px-4">
          <h1 className="text-5xl md:text-7xl font-bold mb-4 tracking-tight">
            {t('hero_title')}
          </h1>
          <p className="text-xl md:text-2xl text-gray-300 mb-8">
            {t('hero_subtitle')}
          </p>
          <p className="text-sm text-gray-500 animate-bounce">
            &#8595; {t('scroll_hint')}
          </p>
        </div>
      </section>

      {/* Scroll-driven product interior reveal sections */}
      <section className="min-h-screen bg-gray-950 text-white py-20">
        <div className="max-w-7xl mx-auto px-4 space-y-32">
          <div className="text-center">
            <Placeholder
              label="Scroll Section 1: Product exterior to interior transition"
              height="h-96"
              className="border-gray-600 bg-gray-800/30"
            />
          </div>
          <div className="text-center">
            <Placeholder
              label="Scroll Section 2: Interior mechanics detail"
              height="h-96"
              className="border-gray-600 bg-gray-800/30"
            />
          </div>
          <div className="text-center">
            <Placeholder
              label="Scroll Section 3: Engineering specifications"
              height="h-96"
              className="border-gray-600 bg-gray-800/30"
            />
          </div>
        </div>
      </section>

      {/* Product Highlights */}
      <Section title={t('section_products')}>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <Placeholder label="Product Highlight 1" height="h-48" />
          <Placeholder label="Product Highlight 2" height="h-48" />
          <Placeholder label="Product Highlight 3" height="h-48" />
        </div>
      </Section>

      {/* About Preview */}
      <Section title={t('section_about')} dark>
        <Placeholder
          label="Factory Overview / Video"
          height="h-64"
          className="border-gray-600 bg-gray-800/30"
        />
      </Section>

      {/* Contact CTA */}
      <Section title={t('section_contact')}>
        <Placeholder label="Contact CTA / Quick Form" height="h-48" />
      </Section>
    </>
  );
}
