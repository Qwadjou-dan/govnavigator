import type { Config } from 'tailwindcss';

/**
 * Design system notes
 *
 * The palette deliberately avoids the national colours and any state
 * insignia. A product that looks like a government website borrows authority
 * it has not earned, and misleads people about who they can hold responsible
 * (see the wireframe principle "do not look like the State").
 *
 * "Modern & clean" re-theme (v0.4): a cool near-white base, deep slate ink,
 * one confident indigo for actions, and an amber reserved exclusively for
 * "check this before you act". Colour carries meaning here — it is never
 * decoration. Indigo sits deliberately far from state green/gold so the
 * product reads as a modern neutral service, not an official channel.
 */
const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: { DEFAULT: '#F6F8FB', raised: '#FFFFFF', sunk: '#EDF1F7' },
        ink: {
          DEFAULT: '#0F172A',
          soft: '#475569',
          faint: '#8A94A6',
          line: '#E4E9F0',
        },
        night: {
          DEFAULT: '#0B1220',
          raised: '#111A2C',
          sunk: '#070C17',
          line: '#1E2A3D',
          text: '#E3E8F0',
          soft: '#93A1B5',
          faint: '#66748A',
        },
        brand: {
          50: '#EEF2FF',
          100: '#E0E7FF',
          200: '#C7D2FE',
          300: '#A5B4FC',
          400: '#818CF8',
          500: '#6366F1',
          600: '#4F46E5',
          700: '#4338CA',
          800: '#3730A3',
          900: '#312E81',
        },
        ochre: { 100: '#FFF4D6', 300: '#FACC15', 500: '#D97706', 700: '#B45309' },
        flag: { good: '#15803D', warn: '#B45309', bad: '#DC2626', mute: '#64748B' },
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
        card: '0 1px 2px rgba(15,23,42,0.04), 0 6px 16px -8px rgba(15,23,42,0.10)',
        lift: '0 2px 4px rgba(15,23,42,0.05), 0 16px 32px -12px rgba(15,23,42,0.16)',
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
