import { NextResponse } from 'next/server';
import { products } from '@/data/products';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const locale = searchParams.get('locale') || 'en';

  const localized = products.map((p) => ({
    id: p.id,
    name: p.name[locale as 'en' | 'zh'] || p.name.en,
    description: p.description[locale as 'en' | 'zh'] || p.description.en,
    image: p.image,
    model3d: p.model3d,
  }));

  return NextResponse.json(localized);
}
