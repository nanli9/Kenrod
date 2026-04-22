export interface Product {
  id: string;
  name: { en: string; zh: string };
  description: { en: string; zh: string };
  image: string;
  model3d?: string;
}

export const products: Product[] = [
  {
    id: 'sample-product-1',
    name: { en: 'Sample Product A', zh: '示例产品 A' },
    description: {
      en: 'A high-precision manufactured component with exceptional quality.',
      zh: '高精度制造组件，品质卓越。',
    },
    image: '',
    model3d: '/models/sample-product.glb',
  },
  {
    id: 'sample-product-2',
    name: { en: 'Sample Product B', zh: '示例产品 B' },
    description: {
      en: 'An advanced engineered part for industrial applications.',
      zh: '用于工业应用的先进工程零件。',
    },
    image: '',
    model3d: '/models/sample-product.glb',
  },
  {
    id: 'sample-product-3',
    name: { en: 'Sample Product C', zh: '示例产品 C' },
    description: {
      en: 'Custom-designed component meeting the highest standards.',
      zh: '定制设计组件，符合最高标准。',
    },
    image: '',
    model3d: '/models/sample-product.glb',
  },
];
