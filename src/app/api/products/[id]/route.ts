import { NextResponse } from 'next/server';
import { products } from '@/data/products';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const locale = searchParams.get('locale') || 'en';
  const product = products.find((p) => p.id === id);

  if (!product) {
    return NextResponse.json({ error: 'Product not found' }, { status: 404 });
  }

  return NextResponse.json({
    id: product.id,
    name: product.name[locale as 'en' | 'zh'] || product.name.en,
    description:
      product.description[locale as 'en' | 'zh'] || product.description.en,
    image: product.image,
    model3d: product.model3d,
  });
}
