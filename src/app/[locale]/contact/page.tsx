'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import Section from '@/components/ui/Section';
import Placeholder from '@/components/ui/Placeholder';

export default function ContactPage() {
  const t = useTranslations('contact');
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = {
      name: (form.elements.namedItem('name') as HTMLInputElement).value,
      email: (form.elements.namedItem('email') as HTMLInputElement).value,
      message: (form.elements.namedItem('message') as HTMLTextAreaElement).value,
    };

    const res = await fetch('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    if (res.ok) {
      setSubmitted(true);
      form.reset();
    }
  };

  return (
    <Section title={t('title')}>
      <p className="text-center text-gray-600 mb-12">{t('description')}</p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 max-w-5xl mx-auto">
        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label className="block text-sm font-medium mb-1">{t('name')}</label>
            <input
              name="name"
              required
              className="w-full border border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-accent focus:border-transparent outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">{t('email')}</label>
            <input
              name="email"
              type="email"
              required
              className="w-full border border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-accent focus:border-transparent outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">{t('message')}</label>
            <textarea
              name="message"
              rows={5}
              required
              className="w-full border border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-accent focus:border-transparent outline-none"
            />
          </div>
          <button
            type="submit"
            className="bg-accent text-white px-6 py-3 rounded-lg font-medium hover:bg-red-600 transition-colors"
          >
            {t('submit')}
          </button>
          {submitted && (
            <p className="text-green-600 text-sm">{t('success')}</p>
          )}
        </form>

        <div>
          <Placeholder label="Map / Factory Location" height="h-64" />
          <div className="mt-6">
            <Placeholder label="Contact Details (Phone, Email, WeChat)" height="h-32" />
          </div>
        </div>
      </div>
    </Section>
  );
}
