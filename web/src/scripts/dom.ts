// Tiny DOM builder for the account scripts. Everything is made with DOM methods and textContent,
// never innerHTML: names and labels come from public records and from visitors.

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  el.append(...children.filter((c): c is Node | string | number => c !== null && c !== undefined && c !== false).map((c) => (typeof c === 'number' ? String(c) : c)));
  return el;
}

const SVG = 'http://www.w3.org/2000/svg';
export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, ...children: (Node | string)[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  el.append(...children);
  return el;
}

/** An SVG <title> child, the hover text for a mark. */
export const tip = (text: string): SVGElement => s('title', {}, text);

export function link(href: string | null, text: string, cls?: string, external = false): HTMLElement {
  return href
    ? h('a', { href, class: cls, ...(external ? { rel: 'noopener nofollow', target: '_blank' } : {}) }, text)
    : h('span', { class: cls }, text);
}
