# Kenrod Manufacturing

A single-page showcase website for Kenrod Manufacturing built with Next.js 15, React Three Fiber, and Tailwind CSS. Features a scroll-driven 3D animation, bilingual support (English/Chinese), and links to external stores and social media.

## Tech Stack

- **Next.js 15** + React 19 + TypeScript
- **React Three Fiber** + drei — 3D scroll-driven product animation
- **next-intl** — i18n (English / Chinese)
- **Tailwind CSS** — styling

## Getting Started

### Prerequisites

- Node.js 20+
- npm

### Install & Run

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Build

```bash
npm run build
npm start
```

### Lint

```bash
npm run lint
```

## Project Structure

```
src/
├── app/
│   ├── [locale]/          # i18n-routed pages
│   │   ├── page.tsx       # Single-page homepage (server component)
│   │   ├── layout.tsx     # Locale layout with Header/Footer
│   │   ├── not-found.tsx  # 404 page
│   │   ├── error.tsx      # Error boundary
│   │   └── loading.tsx    # Loading state
│   ├── layout.tsx         # Root layout
│   ├── page.tsx           # Root redirect → /en
│   └── globals.css
├── components/
│   ├── HomeClient.tsx     # Main page sections (client component)
│   ├── layout/
│   │   ├── Header.tsx     # Sticky nav with anchor links + mobile menu
│   │   ├── Footer.tsx     # Social + store links
│   │   └── LanguageSwitcher.tsx
│   └── three/
│       └── ScrollScene.tsx # Scroll-driven 3D animation
├── i18n/                  # next-intl config
│   ├── routing.ts
│   ├── request.ts
│   └── navigation.ts
└── middleware.ts           # Locale detection middleware
messages/
├── en.json                # English translations
└── zh.json                # Chinese translations
```

## Deployment (Vercel — Free)

The simplest and cheapest way to deploy:

1. Push your repo to GitHub
2. Go to [vercel.com](https://vercel.com) and sign in with GitHub
3. Click **"Import Project"** and select the Kenrod repo
4. Vercel auto-detects Next.js — no config needed
5. Click **Deploy**

Your site will be live at `https://kenrod.vercel.app` (or similar).

### Custom Domain

1. In Vercel dashboard → Project Settings → Domains
2. Add your domain (e.g. `kenrod.com`)
3. Update DNS at your registrar:
   - **CNAME**: `cname.vercel-dns.com` (for subdomains)
   - **A record**: `76.76.21.21` (for apex domain)
4. SSL is provisioned automatically

### Alternative: Docker

A Dockerfile is included for VPS deployment:

```bash
cd docker
docker compose up --build -d
```

This runs the app on port 3000. You'll need a reverse proxy (e.g. Caddy, nginx) in front for HTTPS.

## Customization

### External Links

All store and social media links are placeholders (`#`). Search for `TODO` in the codebase to find them:

- `src/components/HomeClient.tsx` — Shopify/Amazon buy buttons, social media icons
- `src/components/layout/Footer.tsx` — store and social links in footer

### Content

Edit `messages/en.json` and `messages/zh.json` to update text content. Changes take effect on rebuild/reload.

### Product Images

Replace the placeholder text in `HomeClient.tsx` product cards with `<img>` or Next.js `<Image>` tags. Put images in `public/images/products/`.

### 3D Model

The scroll animation currently uses a procedural torus knot. To use a real `.glb` model, update `src/components/three/ScrollScene.tsx` — replace the geometry with `useGLTF` from drei and put the model file in `public/models/`.
