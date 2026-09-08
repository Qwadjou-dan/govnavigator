import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Footer, Header, IndependenceBar } from '@/components/Shell';

export const metadata: Metadata = {
  title: {
    default: 'GovNavigator Ghana — one question, one cited answer',
    template: '%s · GovNavigator Ghana',
  },
  description:
    'Describe what you want to do with a Ghanaian government institution in your own words, and get the responsible office, what to bring, what it costs today and the steps — with the official source for every claim.',
  applicationName: 'GovNavigator Ghana',
  manifest: '/manifest.json',
  robots: { index: true, follow: true },
  openGraph: {
    title: 'GovNavigator Ghana',
    description:
      'One question, one answer: who, what, how and where for any Ghana government service — with sources you can check.',
    type: 'website',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F6F8FB' },
    { media: '(prefers-color-scheme: dark)', color: '#0B1220' },
  ],
};

/**
 * Applied before paint so a person who chose dark mode never sees a flash of
 * white. On a slow connection that flash is the first thing they would see.
 */
const THEME_SCRIPT = `(function(){try{var s=localStorage.getItem('gn.theme');var d=s?s==='dark':matchMedia('(prefers-color-scheme: dark)').matches;if(d)document.documentElement.classList.add('dark')}catch(e){}})();`;

/**
 * Offline reading (Phase 4). Registered only in production builds: `next dev`
 * mutates the module graph constantly and a worker caching those chunks would
 * serve stale code. After a page load, the worker pre-caches the shell and
 * caches visited service data so they survive a dropped signal.
 */
const SW_SCRIPT = `(function(){try{if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(e){console.warn('sw:',e)})})}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GH" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {process.env.NODE_ENV === 'production' && (
          <script dangerouslySetInnerHTML={{ __html: SW_SCRIPT }} />
        )}
      </head>
      <body className="min-h-dvh">
        <a
          href="#main"
          className="no-print sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-brand-500 focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
        >
          Skip to content
        </a>
        <IndependenceBar />
        <Header />
        <main id="main" className="mx-auto max-w-5xl px-4 py-6 sm:py-8">
          {children}
        </main>
        <Footer />
      </body>
    </html>
  );
}
