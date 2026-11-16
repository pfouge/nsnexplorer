// Where a visitor is asked before analytics or advertising cookies are set: the 27 EU
// member states plus the rest of the EEA (IS, LI, NO), the United Kingdom and Switzerland.
// One list for the region endpoint (/api/region.json) and for the Google Consent Mode v2
// defaults in BaseLayout, so the two cannot disagree.
export const CONSENT_COUNTRIES = [
  // European Union
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU',
  'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  // Rest of the EEA, the United Kingdom, Switzerland
  'IS', 'LI', 'NO', 'GB', 'CH',
] as const;

const SET = new Set<string>(CONSENT_COUNTRIES);

export function consentRequired(country: string | null | undefined): boolean {
  // No country on the request (local dev, unusual networks): ask.
  if (!country || country === 'XX' || country === 'T1') return true;
  return SET.has(country.toUpperCase());
}
