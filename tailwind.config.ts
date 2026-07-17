import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Warm near-black, like lacquered wood — dark sections (hero, stats, contact, footer)
        lacquer: {
          DEFAULT: '#0b0a08',
          raised: '#141109',
        },
        // Warm gallery paper — light sections where the photography hangs
        paper: {
          DEFAULT: '#f5f1e8',
          deep: '#ebe4d4',
        },
        // Warm ink for text on paper
        ink: {
          DEFAULT: '#1d1912',
          soft: '#57503f',
        },
        // Ivory/bone for text on lacquer
        ivory: '#f2ede0',
        bone: {
          DEFAULT: '#cec4ad',
          dim: '#877e69',
        },
        // Imperial jade — the accent; deep works on paper, bright on lacquer
        jade: {
          DEFAULT: '#12896b',
          bright: '#3bc79d',
          deep: '#0b5c49',
        },
        // Champagne brass — hairlines and micro-details only
        brass: {
          DEFAULT: '#c9a96b',
          dim: '#9a8256',
        },
        // Vermilion — reserved exclusively for the 国友 seal chop
        seal: '#b23b2b',
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', '-apple-system', 'sans-serif'],
        display: [
          'var(--font-fraunces)',
          'var(--font-noto-serif-sc)',
          'Georgia',
          'Songti SC',
          'serif',
        ],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      keyframes: {
        fadeUp: {
          from: { opacity: '0', transform: 'translateY(16px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        scrollLine: {
          '0%': { transform: 'scaleY(0)', transformOrigin: 'top' },
          '45%': { transform: 'scaleY(1)', transformOrigin: 'top' },
          '55%': { transform: 'scaleY(1)', transformOrigin: 'bottom' },
          '100%': { transform: 'scaleY(0)', transformOrigin: 'bottom' },
        },
        pulseSoft: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' },
        },
      },
      animation: {
        'fade-up': 'fadeUp 0.9s cubic-bezier(0.22, 1, 0.36, 1) both',
        'scroll-line': 'scrollLine 2.2s cubic-bezier(0.65, 0, 0.35, 1) infinite',
        'pulse-soft': 'pulseSoft 2.4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
