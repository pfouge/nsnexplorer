// Per-visitor "hide this supply class" list for /open/. Stored in localStorage as a
// JSON array of 4-character class codes; these helpers are the pure part (no DOM).

export const HIDDEN_CLASSES_KEY = 'nsn.hiddenClasses.v1';
export const MAX_HIDDEN = 500;

const CODE = /^[0-9A-Z]{4}$/;

/** A class code is exactly four characters, digits or capital letters (e.g. "5340"). */
export function isClassCode(v: unknown): v is string {
  return typeof v === 'string' && CODE.test(v);
}

/** Valid, de-duplicated, sorted codes from any input; never throws. */
export function cleanClasses(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  for (const v of list) {
    if (typeof v !== 'string') continue;
    const c = v.trim().toUpperCase();
    if (isClassCode(c)) seen.add(c);
    if (seen.size >= MAX_HIDDEN) break;
  }
  return [...seen].sort();
}

/** Parses the stored string (null/garbage gives an empty list). */
export function parseHidden(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    return cleanClasses(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function serialiseHidden(list: readonly string[]): string {
  return JSON.stringify(cleanClasses([...list]));
}

/** Adds the code if absent, removes it if present. Invalid codes leave the list unchanged. */
export function toggleHidden(list: readonly string[], code: string): string[] {
  const c = typeof code === 'string' ? code.trim().toUpperCase() : '';
  const base = cleanClasses([...list]);
  if (!isClassCode(c)) return base;
  return base.includes(c) ? base.filter((x) => x !== c) : cleanClasses([...base, c]);
}
