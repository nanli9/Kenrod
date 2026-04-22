import { getTranslations, getLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { Link } from '@/i18n/navigation';
import Section from '@/components/ui/Section';
import Placeholder from '@/components/ui/Placeholder';
import { products } from '@/data/products';
import ProductViewer3D from '@/components/products/ProductViewer3D';

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const t = await getTranslations('products');
  const locale = await getLocale();
  const product = products.find((p) => p.id === id);

  if (!product) {
    notFound();
  }

  return (
    <Section>
      <Link href="/products" className="text-accent hover:underline text-sm mb-8 inline-block">
        &larr; {t('back')}
      </Link>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
        <div>
          <h1 className="text-4xl font-bold mb-4">
            {product.name[locale as 'en' | 'zh']}
          </h1>
          <p className="text-gray-600 mb-8">
            {product.description[locale as 'en' | 'zh']}
          </p>
          <Placeholder label="Product Specifications Table" height="h-48" />
        </div>

        <div>
          <h3 className="text-lg font-semibold mb-4">{t('view_3d')}</h3>
          <ProductViewer3D modelPath={product.model3d} />
        </div>
      </div>

      <div className="mt-16">
        <Placeholder label="Related Products / Downloads" height="h-32" />
      </div>
    </Section>
  );
}
