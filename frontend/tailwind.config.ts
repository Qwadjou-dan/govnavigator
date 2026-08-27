import type { Config } from 'tailwindcss';

/**
 * Design system notes
 *
 * The palette deliberately avoids the national colours and any state
 * insignia. A product that looks like a government website borrows authority
 * it has not earned, and misleads people about who they can hold responsible
 * (see the wireframe principle "do not look like the State").
 *
 * Instead: a warm paper base, deep ink text, one confident teal for actions,
 * and an earth-toned amber reserved exclusively for "check this before you
 * act". Colour carries meaning here — it is never decoration.
 */
const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: { DEFAULT: '#FAF9F6', raised: '#FFFFFF', sunk: '#F1F0EC' },
        ink: {
          DEFAULT: '#111A22',
          soft: '#3D4A55',
          faint: '#6B7A87',
          line: '#E2E0DA',
        },
        night: {
          DEFAULT: '#0B1015',
          raised: '#131A21',
          sunk: '#080C10',
          line: '#232D36',
          text: '#E6EAEE',
          soft: '#A3B0BB',
          faint: '#6D7C88',
        },
        brand: {
          50: '#E9F5F2',
          100: '#C7E7DF',
          200: '#93CFC1',
          300: '#5CB4A1',
          400: '#2F9A84',
          500: '#0B7F6B',
          600: '#076657',
          700: '#054E43',
          800: '#04382F',
          900: '#02241E',
        },
        ochre: { 100: '#FBEEE0', 300: '#E7B77E', 500: '#C2703A', 700: '#8C4B20' },
        flag: { good: '#1E7F4F', warn: '#B4741B', bad: '#B3402F', mute: '#5C6B78' },
      },
      fontFamily: {
        // System stack only. next/font would pull webfonts at build time and
        // add payload; NFR-2 caps the initial page at 200KB and our primary
        // users are on metered data and low-end Android devices.
        sans: [
          'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto',
          'Helvetica Neue', 'Arial', 'Noto Sans', 'sans-serif',
        ],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.04em' }],
      },
      borderRadius: { xl2: '1.25rem' },
      boxShadow: {
        card: '0 1px 2px rgba(17,26,34,0.04), 0 8px 24px -12px rgba(17,26,34,0.18)',
        lift: '0 2px 6px rgba(17,26,34,0.06), 0 20px 48px -20px rgba(17,26,34,0.28)',
        inset: 'inset 0 1px 0 rgba(255,255,255,0.6)',
      },
      keyframes: {
        rise: { '0%': { opacity: '0', transform: 'translateY(10px)' }, '100%': { opacity: '1', transform: 'none' } },
        sweep: { '0%': { backgroundPosition: '200% 0' }, '100%': { backgroundPosition: '-200% 0' } },
        pulseDot: { '0%,100%': { opacity: '0.35' }, '50%': { opacity: '1' } },
        grow: { '0%': { transform: 'scaleX(0)' }, '100%': { transform: 'scaleX(1)' } },
      },
      animation: {
        rise: 'rise .38s cubic-bezier(.22,.9,.3,1) both',
        sweep: 'sweep 1.6s linear infinite',
        pulseDot: 'pulseDot 1.2s ease-in-out infinite',
        grow: 'grow .5s cubic-bezier(.22,.9,.3,1) both',
      },
    },
  },
  plugins: [],
};

export default config;
