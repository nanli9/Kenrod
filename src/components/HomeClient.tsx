'use client';

import ScrollScene from '@/components/three/ScrollScene';

interface HomeClientProps {
  hero: {
    title: string;
    subtitle: string;
    scrollHint: string;
  };
  stages: { title: string; text: string }[];
  products: {
    title: string;
    description: string;
    buyShopify: string;
    buyAmazon: string;
    items: { name: string; desc: string }[];
  };
  about: {
    title: string;
    description: string;
    capabilities: { title: string; text: string }[];
  };
  contact: {
    title: string;
    description: string;
    emailCta: string;
    emailAddress: string;
    followUs: string;
    address: string;
  };
}

function HeroSection({ hero }: { hero: HomeClientProps['hero'] }) {
  return (
    <section className="relative h-screen flex flex-col items-center justify-center bg-primary text-white overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-primary via-primary/90 to-gray-950" />
      <div className="relative z-10 text-center px-4">
        <h1 className="text-5xl md:text-7xl font-bold mb-4 tracking-tight">
          {hero.title}
        </h1>
        <p className="text-xl md:text-2xl text-gray-300 mb-12">
          {hero.subtitle}
        </p>
        <p className="text-sm text-gray-500 animate-bounce">
          &#8595; {hero.scrollHint}
        </p>
      </div>
    </section>
  );
}

function ProductsSection({ products }: { products: HomeClientProps['products'] }) {
  return (
    <section id="products" className="py-20 px-4 bg-white">
      <div className="max-w-7xl mx-auto">
        <h2 className="text-3xl md:text-4xl font-bold text-center mb-4">
          {products.title}
        </h2>
        <p className="text-center text-gray-600 mb-12">
          {products.description}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-8">
          {products.items.map((item, i) => (
            <div
              key={i}
              className="border border-gray-200 rounded-lg overflow-hidden hover:shadow-lg transition-shadow"
            >
              <div className="h-48 bg-gray-100 flex items-center justify-center">
                <span className="text-gray-400 text-sm font-mono">
                  Product Image
                </span>
              </div>
              <div className="p-6">
                <h3 className="text-lg font-semibold mb-2">{item.name}</h3>
                <p className="text-gray-600 text-sm mb-4">{item.desc}</p>
                <div className="flex gap-3">
                  {/* TODO: Replace # with actual store URLs */}
                  <a
                    href="#"
                    className="flex-1 text-center px-4 py-2 bg-accent text-white text-sm rounded hover:bg-red-600 transition-colors"
                  >
                    {products.buyShopify}
                  </a>
                  <a
                    href="#"
                    className="flex-1 text-center px-4 py-2 border border-gray-300 text-gray-700 text-sm rounded hover:bg-gray-50 transition-colors"
                  >
                    {products.buyAmazon}
                  </a>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function AboutSection({ about }: { about: HomeClientProps['about'] }) {
  return (
    <section id="about" className="py-20 px-4 bg-primary text-white">
      <div className="max-w-7xl mx-auto">
        <h2 className="text-3xl md:text-4xl font-bold text-center mb-4">
          {about.title}
        </h2>
        <p className="text-center text-gray-300 mb-12 max-w-2xl mx-auto">
          {about.description}
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {about.capabilities.map((cap, i) => (
            <div
              key={i}
              className="bg-white/5 border border-white/10 rounded-lg p-6 hover:bg-white/10 transition-colors"
            >
              <h3 className="text-lg font-semibold text-accent mb-2">
                {cap.title}
              </h3>
              <p className="text-gray-400 text-sm">{cap.text}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ContactSection({ contact }: { contact: HomeClientProps['contact'] }) {
  return (
    <section id="contact" className="py-20 px-4 bg-white">
      <div className="max-w-3xl mx-auto text-center">
        <h2 className="text-3xl md:text-4xl font-bold mb-4">
          {contact.title}
        </h2>
        <p className="text-gray-600 mb-8">{contact.description}</p>

        {/* Email CTA */}
        <a
          href={`mailto:${contact.emailAddress}`}
          className="inline-block bg-accent text-white px-8 py-4 rounded-lg text-lg font-medium hover:bg-red-600 transition-colors mb-12"
        >
          {contact.emailCta}
        </a>

        {/* Social Media Links */}
        <div className="mb-8">
          <p className="text-gray-500 text-sm mb-4">{contact.followUs}</p>
          <div className="flex justify-center gap-6">
            {/* TODO: Replace # with actual social media URLs */}
            <a href="#" className="text-gray-400 hover:text-accent transition-colors" aria-label="WeChat">
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm3.636 4.3c-1.659-.062-3.215.458-4.369 1.416-1.196.992-1.986 2.467-1.986 4.15 0 .401.065.79.162 1.17.642 2.503 3.235 4.347 6.2 4.347.58 0 1.143-.079 1.685-.228a.55.55 0 0 1 .456.063l1.203.703a.222.222 0 0 0 .107.035.187.187 0 0 0 .183-.186c0-.046-.018-.09-.03-.135l-.248-.935a.374.374 0 0 1 .135-.42C20.436 19.756 21.3 18.25 21.3 16.6c0-.4-.065-.79-.162-1.169-.642-2.503-3.235-4.347-6.2-4.347a7.727 7.727 0 0 0-.704.032zm-2.079 2.294c.407 0 .737.336.737.748a.743.743 0 0 1-.737.749.743.743 0 0 1-.737-.749c0-.412.33-.748.737-.748zm3.692 0c.407 0 .736.336.736.748a.743.743 0 0 1-.736.749.743.743 0 0 1-.737-.749c0-.412.33-.748.737-.748z" />
              </svg>
            </a>
            <a href="#" className="text-gray-400 hover:text-accent transition-colors" aria-label="Instagram">
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z" />
              </svg>
            </a>
            <a href="#" className="text-gray-400 hover:text-accent transition-colors" aria-label="LinkedIn">
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
              </svg>
            </a>
            <a href="#" className="text-gray-400 hover:text-accent transition-colors" aria-label="Facebook">
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
              </svg>
            </a>
          </div>
        </div>

        <p className="text-gray-400 text-sm">{contact.address}</p>
      </div>
    </section>
  );
}

export default function HomeClient({
  hero,
  stages,
  products,
  about,
  contact,
}: HomeClientProps) {
  return (
    <>
      <HeroSection hero={hero} />
      <ScrollScene stages={stages} />
      <ProductsSection products={products} />
      <AboutSection about={about} />
      <ContactSection contact={contact} />
    </>
  );
}
