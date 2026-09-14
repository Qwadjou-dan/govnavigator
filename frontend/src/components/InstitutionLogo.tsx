import { Icon } from './ui';

/**
 * An institution's own logo, used to identify whose service a card describes.
 *
 * Why this is not a contradiction of "do not look like the State"
 * ---------------------------------------------------------------
 * The wireframe principle is about OUR chrome: the header, the colours and the
 * shell must never imply this product is an official channel. A card that says
 * "this requirement belongs to the DVLA" is the opposite — it is telling the
 * person exactly which body is accountable, which is the one thing the product
 * exists to make unambiguous. So the marks appear only inside content cards,
 * never in the header, footer, favicon or theme, and each sits in a plain white
 * well that reads as "third party", not as our own branding.
 *
 * Two marks were deliberately NOT taken from the source sites: the Passport
 * Office (mfa.gov.gh) and NIA both serve the bare Republic of Ghana coat of
 * arms as their site icon. Showing the State's own insignia on our cards is the
 * exact confusion the principle forbids, so the Passport Office falls back to a
 * monogram and NIA uses its wordmark logo instead of its favicon.
 *
 * Assets live in public/brand/institutions/<id>.png — 128px, trimmed and
 * transparent-padded, keyed on Institution.id from the backend. Anything not in
 * HAVE_LOGO (a dead site, a site with no usable mark, or a newly added
 * institution) falls back to an abbreviation monogram, so the grid never has a
 * hole in it.
 */
const HAVE_LOGO = new Set([
  'ama', 'dvla', 'epa', 'fda', 'ghana-police', 'ghana-post', 'gipc', 'gis',
  'gnfs', 'gpha', 'gra', 'gsa', 'lands-commission', 'luspa', 'moti', 'nhia',
  'nia', 'nita', 'npra', 'orc', 'ssnit',
]);

const SIZES = {
  sm: { well: 'h-7 w-11', img: 'max-h-5 max-w-9', mono: 'text-[10px]' },
  md: { well: 'h-9 w-14', img: 'max-h-7 max-w-12', mono: 'text-[11px]' },
  lg: { well: 'h-12 w-[4.5rem]', img: 'max-h-9 max-w-16', mono: 'text-sm' },
} as const;

/** First two initials of the abbreviation, e.g. "GRA" -> "GR", "MoTI" -> "MT". */
function monogram(abbreviation: string, name: string) {
  const source = abbreviation || name;
  const caps = source.replace(/[^A-Za-z]/g, '');
  return (caps.slice(0, 2) || '??').toUpperCase();
}

export function InstitutionLogo({
  id,
  abbreviation,
  name,
  size = 'md',
}: {
  id: string;
  abbreviation: string;
  name: string;
  size?: keyof typeof SIZES;
}) {
  const s = SIZES[size];

  if (!HAVE_LOGO.has(id)) {
    return (
      <span
        aria-hidden="true"
        className={`flex shrink-0 items-center justify-center rounded-lg bg-brand-500/12 font-bold tracking-tight text-brand-700 ring-1 ring-inset ring-brand-500/15 dark:text-brand-200 dark:ring-brand-400/20 ${s.well} ${s.mono}`}
      >
        {monogram(abbreviation, name)}
      </span>
    );
  }

  return (
    <span
      className={`inst-logo flex shrink-0 items-center justify-center rounded-lg bg-white p-1 ring-1 ring-inset ring-ink-line dark:ring-night-line ${s.well}`}
    >
      {/* Plain <img>: next/image is never used in this project (NFR-2 — see the
          font note in tailwind.config.ts), and these are already 128px files. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/brand/institutions/${id}.png`}
        alt=""
        aria-hidden="true"
        loading="lazy"
        decoding="async"
        className={`h-auto w-auto object-contain ${s.img}`}
      />
    </span>
  );
}

/**
 * The generic building glyph, for places that want the old look (an empty
 * state, a section heading) rather than a specific institution.
 */
export function InstitutionGlyph({ className = 'h-4 w-4' }: { className?: string }) {
  return <Icon.building className={className} />;
}
