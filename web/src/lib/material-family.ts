// material-family.ts — groups the free-text FLIS material strings ("ACTUATOR ARM ALUMINUM
// ALLOY 2024", "STEEL COMP 4340") into a short list of families for the class filter.
// Pure; no I/O.

export type MaterialFamily =
  | 'stainless'
  | 'steel'
  | 'aluminum'
  | 'titanium'
  | 'nickel'
  | 'copper'
  | 'rubber'
  | 'plastic'
  | 'composite'
  | 'textile'
  | 'wood'
  | 'other';

export const MATERIAL_FAMILY_LABEL: Record<MaterialFamily, string> = {
  stainless: 'Stainless steel',
  steel: 'Steel and iron',
  aluminum: 'Aluminum',
  titanium: 'Titanium',
  nickel: 'Nickel alloys',
  copper: 'Copper, brass, bronze',
  rubber: 'Rubber and elastomers',
  plastic: 'Plastics',
  composite: 'Glass, carbon, composite',
  textile: 'Fabric and leather',
  wood: 'Wood, paper, cork',
  other: 'Other',
};

// Order matters: first match wins ("CARBON STEEL" is steel, not composite).
const RULES: [MaterialFamily, RegExp][] = [
  ['stainless', /STAINLESS|\bCRES\b|CORROSION[- ]RESIST/],
  ['steel', /STEEL|\bIRON\b/],
  ['aluminum', /ALUMIN/],
  ['titanium', /TITANIUM/],
  ['nickel', /NICKEL|INCONEL|MONEL/],
  ['copper', /COPPER|BRASS|BRONZE/],
  ['rubber', /RUBBER|ELASTOMER|SILICONE|NEOPRENE|NITRILE|BUNA|VITON|EPDM|FLUOROSILICONE/],
  ['plastic', /PLASTIC|NYLON|POLY|PTFE|TEFLON|ACETAL|PHENOLIC|VINYL|ACRYLIC|FLUOROCARBON/],
  ['composite', /FIBERGLASS|GLASS|CARBON|COMPOSITE|GRAPHITE|CERAMIC/],
  ['textile', /FABRIC|CLOTH|COTTON|LEATHER|FELT|TEXTILE|WEBBING|CANVAS/],
  ['wood', /WOOD|PAPER|CORK|FIBERBOARD/],
];

export function materialFamily(raw: string | null | undefined): MaterialFamily | null {
  const s = (raw ?? '').trim().toUpperCase();
  if (s === '') return null;
  for (const [family, re] of RULES) if (re.test(s)) return family;
  return 'other';
}

export function familyCounts(
  materials: (string | null)[]
): { family: MaterialFamily; label: string; count: number }[] {
  const counts = new Map<MaterialFamily, number>();
  for (const m of materials) {
    const f = materialFamily(m);
    if (f) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  return [...counts]
    .map(([family, count]) => ({ family, label: MATERIAL_FAMILY_LABEL[family], count }))
    .sort((a, b) => {
      if (a.family === 'other' || b.family === 'other') return a.family === 'other' ? (b.family === 'other' ? 0 : 1) : -1;
      return b.count - a.count || a.label.localeCompare(b.label);
    });
}
