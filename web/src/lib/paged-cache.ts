// Tiny build-time memo so the pages of one category share one card build.
// Entries are released after the category's last page renders, so memory stays
// bounded to the categories currently being rendered.
const cache = new Map<string, unknown>();

export function memo<T>(key: string, make: () => T): T {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key) as T;
}

export function release(key: string): void {
  cache.delete(key);
}
