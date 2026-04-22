import { useTranslations, useLocale } from 'next-intl';
import Section from '@/components/ui/Section';
import ProductCard from '@/components/products/ProductCard';
import { products } from '@/data/products';

export default function ProductsPage() {
  const t = useTranslations('products');
  const locale = useLocale();

  return (
    <Section title={t('title')}>
      <p className="text-center text-gray-600 mb-12">{t('description')}</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-8">
        {products.map((product) => (
          <ProductCard
            key={product.id}
            id={product.id}
            name={product.name[locale as 'en' | 'zh']}
            image={product.image}
          />
        ))}
      </div>
    </Section>
  );
}
