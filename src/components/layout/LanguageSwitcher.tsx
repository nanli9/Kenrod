'use client';

import { useLocale } from 'next-intl';
import { useRouter, usePathname } from '@/i18n/navigation';

const LOCALES = [
  { code: 'en' as const, label: 'EN' },
  { code: 'zh' as const, label: '中文' },
];

export default function LanguageSwitcher() {
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();

  return (
    <div className="flex items-center border border-white/15 rounded-full p-0.5">
      {LOCALES.map(({ code, label }) => (
        <button
          key={code}
          onClick={() => router.replace(pathname, { locale: code })}
          aria-pressed={locale === code}
          className={`h-7 px-3 rounded-full font-mono text-[10px] tracking-wider transition-colors ${
            locale === code
              ? 'bg-smoke text-void'
              : 'text-mute hover:text-smoke'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
