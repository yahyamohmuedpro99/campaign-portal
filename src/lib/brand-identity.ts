/**
 * A colour per brand, taken from the place the brand operates in.
 *
 * Three companies share one database here, and seeing another company's data is the one
 * failure this portal exists to prevent. Row-level security is what actually prevents it;
 * this is the ambient reminder of whose desk you are sitting at, so that a person who has
 * two tabs open never has to read the header to know. It is the only saturated colour on
 * a page, which is what makes it legible as an identity rather than decoration.
 *
 * Values are oklch so they sit in the same space as the rest of the palette, and each has
 * a dark-theme pair lightened to hold contrast on the dark ground rather than a different
 * hue.
 */
export type BrandIdentity = { light: string; dark: string; place: string };

export const BRAND_IDENTITY: Record<string, BrandIdentity> = {
  // Kenyan highland green.
  kilele: { light: 'oklch(0.47 0.10 158)', dark: 'oklch(0.74 0.115 158)', place: 'Kenya' },
  // The clay of the Karoo.
  karoo: { light: 'oklch(0.49 0.115 48)', dark: 'oklch(0.76 0.115 58)', place: 'South Africa' },
  // Majorelle blue, which is Marrakech's own.
  marrakech: { light: 'oklch(0.46 0.145 265)', dark: 'oklch(0.75 0.115 265)', place: 'Morocco' },
};

const FALLBACK: BrandIdentity = BRAND_IDENTITY.kilele;

/** Inline custom properties for a brand, applied to the portal shell. */
export function brandStyle(slug: string): React.CSSProperties {
  const id = BRAND_IDENTITY[slug] ?? FALLBACK;
  return { '--brand': id.light, '--brand-dark': id.dark } as React.CSSProperties;
}

export function brandPlace(slug: string): string | undefined {
  return BRAND_IDENTITY[slug]?.place;
}

const BY_NAME: Record<string, string> = {
  'Kilele Rides': 'kilele',
  'Karoo Coaches': 'karoo',
  'Marrakech Express': 'marrakech',
};

/** The shared report knows the brand by name, not by slug. */
export function brandStyleByName(name: string): React.CSSProperties {
  return brandStyle(BY_NAME[name] ?? '');
}
