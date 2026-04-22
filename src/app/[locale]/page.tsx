import { useTranslations } from 'next-intl';
import HomeClient from '@/components/HomeClient';

export default function HomePage() {
  const t = useTranslations();

  const stages = [
    { title: t('scroll_scene.stage1_title'), text: t('scroll_scene.stage1_text') },
    { title: t('scroll_scene.stage2_title'), text: t('scroll_scene.stage2_text') },
    { title: t('scroll_scene.stage3_title'), text: t('scroll_scene.stage3_text') },
  ];

  const products = [
    { name: t('products.product1_name'), desc: t('products.product1_desc') },
    { name: t('products.product2_name'), desc: t('products.product2_desc') },
    { name: t('products.product3_name'), desc: t('products.product3_desc') },
  ];

  const capabilities = [
    { title: t('about.capability1_title'), text: t('about.capability1_text') },
    { title: t('about.capability2_title'), text: t('about.capability2_text') },
    { title: t('about.capability3_title'), text: t('about.capability3_text') },
  ];

  return (
    <HomeClient
      hero={{
        title: t('hero.title'),
        subtitle: t('hero.subtitle'),
        scrollHint: t('hero.scroll_hint'),
      }}
      stages={stages}
      products={{
        title: t('products.title'),
        description: t('products.description'),
        buyShopify: t('products.buy_shopify'),
        buyAmazon: t('products.buy_amazon'),
        items: products,
      }}
      about={{
        title: t('about.title'),
        description: t('about.description'),
        capabilities,
      }}
      contact={{
        title: t('contact.title'),
        description: t('contact.description'),
        emailCta: t('contact.email_cta'),
        emailAddress: t('contact.email_address'),
        followUs: t('contact.follow_us'),
        address: t('contact.address'),
      }}
    />
  );
}
