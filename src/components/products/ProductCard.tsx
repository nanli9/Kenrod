import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';

export default function ProductCard({
  id,
  name,
  image,
}: {
  id: string;
  name: string;
  image: string;
}) {
  const t = useTranslations('products');

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden hover:shadow-lg transition-shadow">
      <div className="h-48 bg-gray-100 flex items-center justify-center">
        {image ? (
          <img src={image} alt={name} className="h-full w-full object-cover" />
        ) : (
          <span className="text-gray-400 text-sm font-mono">
            Product Image
          </span>
        )}
      </div>
      <div className="p-4">
        <h3 className="text-lg font-semibold mb-2">{name}</h3>
        <Link
          href={`/products/${id}` as '/products/[id]'}
          className="text-accent text-sm font-medium hover:underline"
        >
          {t('view_detail')} &rarr;
        </Link>
      </div>
    </div>
  );
}
