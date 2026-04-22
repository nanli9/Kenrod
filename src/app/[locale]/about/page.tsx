import { useTranslations } from 'next-intl';
import Section from '@/components/ui/Section';
import Placeholder from '@/components/ui/Placeholder';

export default function AboutPage() {
  const t = useTranslations('about');

  return (
    <>
      <Section title={t('title')}>
        <p className="text-center text-gray-600 mb-12">{t('description')}</p>
        <Placeholder label="Factory History / Story" height="h-64" />
      </Section>

      <Section dark>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <Placeholder
            label="Factory Photo / Virtual Tour"
            height="h-64"
            className="border-gray-600 bg-gray-800/30"
          />
          <Placeholder
            label="Capabilities / Equipment List"
            height="h-64"
            className="border-gray-600 bg-gray-800/30"
          />
        </div>
      </Section>

      <Section>
        <Placeholder label="Team / Certifications" height="h-48" />
      </Section>
    </>
  );
}
