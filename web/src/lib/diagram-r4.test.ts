import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDiagram, buildThumbnail, diagramBuilder } from './diagram.ts';

// Round 4 families. Every fixture below is a real production characteristic record (public FLIS data) copied from
// the read-only coverage run of 2026-11-16 (NSN in the comment), with the requirements the drawing does not read left out.
type Fx = { fsc: string; name: string; chars: Record<string, string>; nsn: string };
const E = (o: Record<string, string>) => Object.entries(o).map(([requirement, reply]) => ({ mrc: null, requirement, reply }));
const O = (name: string) => ({ nsnDashed: '0000-00-000-0000', itemName: name });

const FX: Record<string, Fx> = {
  tee: { nsn: '4730002782789', fsc: '4730', name: 'TEE,TUBE', chars: { 'LEG LENGTH': 'FIRST END INCHES NOMINAL 2.656', 'LEG LENGTH ': 'THIRD END INCHES NOMINAL 1.766', 'NOMINAL OUTSIDE DIAMETER TUBE ACCOMMODATED': 'ALL ENDS INCHES 0.750' } },
  cross: { nsn: '4730010415233', fsc: '4730', name: 'CROSS,TUBE', chars: { 'LEG LENGTH': 'ALL ENDS INCHES NOMINAL 1.660', 'NOMINAL THREAD SIZE': 'ALL ENDS INCHES 1.062', 'NOMINAL OUTSIDE DIAMETER TUBE ACCOMMODATED': 'ALL ENDS INCHES 0.750' } },
  nipple: { nsn: '4730001144049', fsc: '4730', name: 'NIPPLE,PIPE', chars: { 'NOMINAL OVERALL LENGTH': 'INCHES 5.000', 'NOMINAL THREAD SIZE': 'ALL ENDS INCHES 0.250' } },
  union: { nsn: '4730004854788', fsc: '4730', name: 'UNION,TUBE', chars: { 'NOMINAL OVERALL LENGTH': 'INCHES 1.375', 'NOMINAL THREAD SIZE': 'ALL ENDS INCHES 0.750', 'LEG LENGTH': 'ALL ENDS INCHES NOMINAL 0.562' } },
  reducer: { nsn: '4730001873575', fsc: '4730', name: 'REDUCER,BOSS', chars: { 'NOMINAL OVERALL LENGTH': 'INCHES 1.250', 'NOMINAL THREAD SIZE': 'FIRST END INCHES 0.438', 'NOMINAL THREAD SIZE ': 'SECOND END INCHES 0.312' } },
  plug: { nsn: '4730002870100', fsc: '4730', name: 'PLUG,TUBE FITTING,THREADED', chars: { 'NOMINAL THREAD SIZE': 'EXTERNAL INCHES 0.375', 'HEAD HEIGHT': 'INCHES NOMINAL 0.193', 'OVERALL LENGTH': 'INCHES NOMINAL 0.672' } },
  setscrew: { nsn: '5305000090467', fsc: '5305', name: 'SETSCREW', chars: { 'NOMINAL THREAD DIAMETER': 'INCHES 0.190', 'WIDTH ACROSS FLATS': 'INCHES MINIMUM 0.094 AND INCHES MAXIMUM 0.096', 'THREAD LENGTH': 'INCHES MINIMUM 0.820 AND INCHES MAXIMUM 0.840', 'FASTENER LENGTH': 'INCHES MINIMUM 0.960 AND INCHES MAXIMUM 0.980' } },
  roundnut: { nsn: '5310003486199', fsc: '5310', name: 'NUT,PLAIN,ROUND', chars: { 'NOMINAL THREAD SIZE': 'INCHES 1.250', 'NUT DIAMETER': 'INCHES NOMINAL 1.437', 'NUT THICKNESS': 'INCHES NOMINAL 0.750' } },
  blindnut: { nsn: '5310002085117', fsc: '5310', name: 'NUT,PLAIN,BLIND RIVET', chars: { 'NOMINAL THREAD SIZE': 'INCHES 0.190', 'NUT DIAMETER': 'INCHES NOMINAL 0.251', 'NUT LENGTH': 'INCHES NOMINAL 0.500', 'HEAD DIAMETER': 'INCHES NOMINAL 0.385', 'HEAD HEIGHT': 'INCHES NOMINAL 0.063' } },
  selfalign: { nsn: '3120000799279', fsc: '3120', name: 'BEARING,PLAIN,SELF-ALIGNING', chars: { 'BORE DIAMETER': 'INCHES MINIMUM 0.3120 AND INCHES MAXIMUM 0.3125', 'OUTER MEMBER OUTSIDE DIAMETER': 'INCHES MINIMUM 0.7495 AND INCHES MAXIMUM 0.7500', 'OUTER MEMBER WIDTH': 'INCHES NOMINAL 0.2810', 'INNER MEMBER WIDTH': 'INCHES MINIMUM 0.3700 AND INCHES MAXIMUM 0.3750' } },
  spacerplate: { nsn: '5365002726239', fsc: '5365', name: 'SPACER,PLATE', chars: { 'OVERALL WIDTH': 'INCHES NOMINAL 0.750', 'OVERALL LENGTH': 'INCHES NOMINAL 1.000', 'APERTURE DIAMETER': 'INCHES MINIMUM 0.479 AND INCHES MAXIMUM 0.485' } },
  woodruff: { nsn: '5315000117995', fsc: '5315', name: 'KEY,WOODRUFF', chars: { 'KEY SIZE DESIGNATION': 'WOODRUFF F', 'KEY HEIGHT': 'INCHES MINIMUM 0.589 AND INCHES MAXIMUM 0.594', 'CIRCLE DIAMETER': 'INCHES MINIMUM 1.365 AND INCHES MAXIMUM 1.375', 'THICKNESS': 'INCHES MINIMUM 0.3750 AND INCHES MAXIMUM 0.3760' } },
};
// requirement keys that need a second entry with the same name
const entriesOf = (f: Fx): { mrc: null; requirement: string; reply: string }[] => Object.entries(f.chars).map(([k, v]) => ({ mrc: null, requirement: k.trim(), reply: v }));

/** Checks every coordinate against the viewBox, NaN, and text vs the title block / other text. */
function check(svg: string) {
  assert.ok(!/NaN|Infinity|undefined/.test(svg), 'no NaN');
  const vb = svg.match(/viewBox="0 0 (\d+) (\d+)"/)!;
  const W = Number(vb[1]);
  const H = Number(vb[2]);
  for (const m of svg.matchAll(/<(line|circle|rect|text)\b([^>]*)>/g)) {
    const a = Object.fromEntries([...m[2].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    for (const k of ['x', 'x1', 'x2', 'cx']) if (a[k] !== undefined) assert.ok(Number(a[k]) >= 0 && Number(a[k]) <= W, `${m[1]} ${k}=${a[k]} outside`);
    for (const k of ['y', 'y1', 'y2', 'cy']) if (a[k] !== undefined) assert.ok(Number(a[k]) >= 0 && Number(a[k]) <= H, `${m[1]} ${k}=${a[k]} outside`);
    if (m[1] === 'rect') {
      assert.ok(Number(a.x) + Number(a.width) <= W + 0.5 && Number(a.y) + Number(a.height) <= H + 0.5, 'rect outside');
    }
  }
  const polys = [...svg.matchAll(/points="([^"]+)"/g)].flatMap((m) => m[1].split(/[ ,]/).map(Number));
  assert.ok(polys.every((v) => Number.isFinite(v) && v >= 0 && v <= Math.max(W, H)));
  // text extents
  const texts = [...svg.matchAll(/<text x="([\d.-]+)" y="([\d.-]+)" class="(dg-\w+)" text-anchor="(\w+)">([^<]*)<\/text>/g)].map((m) => {
    const px = { 'dg-dim': 13, 'dg-note': 10, 'dg-label': 14, 'dg-title': 15 }[m[3] as 'dg-dim']!;
    const w = m[5].length * px * 0.62;
    const x = Number(m[1]);
    const x0 = m[4] === 'middle' ? x - w / 2 : m[4] === 'end' ? x - w : x;
    return { x0, x1: x0 + w, y: Number(m[2]), px, s: m[5], cls: m[3] };
  });
  const body = texts.filter((t) => t.y < 430);
  for (const t of body) assert.ok(t.x0 >= 20 && t.x1 <= W - 20, `text off sheet: ${t.s} ${t.x0}-${t.x1}`);
  for (const t of body) assert.ok(t.y <= 430, `text in title block: ${t.s}`);
  for (let i = 0; i < body.length; i++)
    for (let j = i + 1; j < body.length; j++) {
      const a = body[i];
      const b = body[j];
      const overlap = a.x0 < b.x1 - 2 && b.x0 < a.x1 - 2 && Math.abs(a.y - b.y) < Math.min(a.px, b.px) * 0.9;
      assert.ok(!overlap, `text overlap: "${a.s}" / "${b.s}"`);
    }
}


for (const [k, f] of Object.entries(FX)) {
  test(`r4 ${k} (${f.nsn}): drawing and thumbnail agree, geometry inside the sheet`, () => {
    const e = entriesOf(f);
    const svg = buildDiagram(e, f.fsc, O(f.name));
    assert.ok(svg, 'drawn');
    assert.equal(diagramBuilder(e, f.fsc, O(f.name)), k);
    assert.ok(buildThumbnail(e, f.fsc, f.name), 'thumbnail');
    check(svg!);
    assert.match(svg!, /REFERENCE ONLY, NOT FOR MANUFACTURE/);
    assert.ok(!svg!.includes('…'), 'title block text is not clipped');
  });
  test(`r4 ${k}: dropping any one requirement keeps drawing and thumbnail in step`, () => {
    for (const drop of Object.keys(f.chars)) {
      const rest = { ...f.chars };
      delete rest[drop];
      const e = Object.entries(rest).map(([kk, v]) => ({ mrc: null, requirement: kk.trim(), reply: v }));
      const svg = buildDiagram(e, f.fsc, O(f.name));
      const th = buildThumbnail(e, f.fsc, f.name);
      // FSC 3120 already shows a generic tube silhouette for any part with an outside diameter and bore, drawing or not
      if (k !== 'selfalign') assert.equal(!!svg, !!th, `parity without ${drop}`);
      if (svg) check(svg);
    }
    assert.equal(buildDiagram([], f.fsc, O(f.name)), null);
    assert.equal(buildThumbnail([], f.fsc, f.name), null);
  });
}

test('r4: dimension text is the catalog text', () => {
  const g = (k: string) => buildDiagram(entriesOf(FX[k]), FX[k].fsc, O(FX[k].name))!;
  for (const t of ['0.960–0.980 LG', '0.820–0.840 THREAD LG', '⌀0.190 THREAD', '0.094–0.096 A/F']) assert.ok(g('setscrew').includes(t), t);
  for (const t of ['⌀1.437', '1.250', '0.750 THICKNESS']) assert.ok(g('roundnut').includes(t), t);
  for (const t of ['0.500 NUT LG', '0.063 HEAD H', '⌀0.385 HEAD', '⌀0.251 BODY']) assert.ok(g('blindnut').includes(t), t);
  for (const t of ['1.365–1.375', '0.589–0.594 HEIGHT', '0.3750–0.3760 THK', 'WOODRUFF F']) assert.ok(g('woodruff').includes(t), t);
  for (const t of ['0.2810 OUTER MEMBER WIDTH', '0.3700–0.3750 INNER MEMBER WIDTH', '⌀0.7495–0.7500', '⌀0.3120–0.3125']) assert.ok(g('selfalign').includes(t), t);
  for (const t of ['1.000 LG', '0.750 W']) assert.ok(g('spacerplate').includes(t), t);
  for (const t of ['0.672 OVERALL LG', '0.193 HEAD H', '⌀0.375 THREAD']) assert.ok(g('plug').includes(t), t);
});

test('r4: fittings say schematic, number the ends and label only stated sizes', () => {
  const g = (k: string) => buildDiagram(entriesOf(FX[k]), FX[k].fsc, O(FX[k].name))!;
  for (const k of ['tee', 'cross', 'nipple', 'union', 'reducer']) assert.match(g(k), /SCHEMATIC, NOT TO SCALE/, k);
  const tee = g('tee');
  assert.ok(tee.includes('2.656 LEG LG') && tee.includes('1.766 LEG LG') && tee.includes('TUBE OD ⌀0.750'));
  assert.ok(!/THREAD ⌀/.test(tee), 'no thread size stated for the tee');
  assert.ok(tee.includes('NO SIZE STATED') === false, 'all three ends carry the tube size');
  const cross = g('cross');
  assert.ok(cross.includes('END 4') && cross.includes('1.660 LEG LG') && cross.includes('THREAD ⌀1.062'));
  const red = g('reducer');
  assert.ok(red.includes('THREAD ⌀0.438') && red.includes('THREAD ⌀0.312') && red.includes('1.250 OVERALL LG'));
  assert.ok(!red.includes('NOT COMPARABLE'));
});

test('r4: a per-end size that is qualified, repeated or in another unit is not drawn as a label', () => {
  // real tee 4730002782789: the thread size is stated for ALL ENDS and again for "FIRST END BULKHEAD"; neither is used
  const bulk = [...entriesOf(FX.tee), { mrc: null, requirement: 'NOMINAL THREAD SIZE', reply: 'ALL ENDS INCHES 1.062' }, { mrc: null, requirement: 'NOMINAL THREAD SIZE', reply: 'FIRST END BULKHEAD INCHES 1.062' }];
  const svg = buildDiagram(bulk, '4730', O('TEE,TUBE'))!;
  assert.ok(svg && !/THREAD ⌀/.test(svg));
  // the same end stated twice with different values: that end is left unlabelled
  const clash = [...entriesOf(FX.nipple), { mrc: null, requirement: 'NOMINAL THREAD SIZE', reply: 'FIRST END INCHES 0.500' }];
  const cl = buildDiagram(clash, '4730', O('NIPPLE,PIPE'))!;
  assert.equal(cl.split('THREAD ⌀0.250').length - 1, 1, 'only the unconflicted end is labelled');
  assert.equal(cl.includes('⌀0.500'), false);
  // mixed units are refused outright
  const mixed = entriesOf(FX.union).map((e) => (e.requirement === 'NOMINAL OVERALL LENGTH' ? { ...e, reply: 'MILLIMETERS NOMINAL 35' } : e));
  assert.equal(buildDiagram(mixed, '4730', O('UNION,TUBE')), null);
  // a two-ended fitting without an overall length has no drawing
  assert.equal(buildDiagram(entriesOf(FX.nipple).filter((e) => e.requirement !== 'NOMINAL OVERALL LENGTH'), '4730', O('NIPPLE,PIPE')), null);
});

test('r4: reducer draws the larger end larger only when both ends state the same kind of size', () => {
  const same = buildDiagram(entriesOf(FX.reducer), '4730', O('REDUCER,BOSS'))!;
  assert.ok(/points="200,\d+(?:\.\d+)? 560,\d+(?:\.\d+)? /.test(same));
  const mixedKinds = [
    { mrc: null, requirement: 'NOMINAL OVERALL LENGTH', reply: 'INCHES 1.250' },
    { mrc: null, requirement: 'NOMINAL THREAD SIZE', reply: 'FIRST END INCHES 0.438' },
    { mrc: null, requirement: 'NOMINAL OUTSIDE DIAMETER TUBE ACCOMMODATED', reply: 'SECOND END INCHES 0.188' },
  ];
  assert.match(buildDiagram(mixedKinds, '4730', O('REDUCER,TUBE'))!, /NOT COMPARABLE, BODY SHOWN STRAIGHT/);
});

test('r4: plug accepts the EXTERNAL qualifier only, and not a thread longer than the shank', () => {
  const f = entriesOf(FX.plug);
  assert.ok(buildDiagram(f, '4730', O('PLUG,TUBE FITTING,THREADED')));
  const internal = f.map((e) => (e.requirement === 'NOMINAL THREAD SIZE' ? { ...e, reply: 'INTERNAL INCHES 0.375' } : e));
  assert.equal(buildDiagram(internal, '4730', O('PLUG,TUBE FITTING,THREADED')), null);
  const long = [...f, { mrc: null, requirement: 'THREAD LENGTH', reply: 'EXTERNAL INCHES NOMINAL 0.900' }];
  assert.equal(buildDiagram(long, '4730', O('PLUG,TUBE FITTING,THREADED')), null);
  const ok = [...f, { mrc: null, requirement: 'THREAD LENGTH', reply: 'EXTERNAL INCHES NOMINAL 0.390' }];
  assert.ok(buildDiagram(ok, '4730', O('PLUG,TUBE FITTING,THREADED'))!.includes('0.390 THREAD LG'));
  // machine-thread plug in FSC 5365 (real: 5365000505291)
  const mt = E({ 'NOMINAL THREAD SIZE': 'EXTERNAL INCHES 0.375', 'HEAD HEIGHT': 'INCHES NOMINAL 0.219', 'OVERALL LENGTH': 'INCHES NOMINAL 0.594', 'THREAD LENGTH': 'EXTERNAL INCHES NOMINAL 0.282' });
  assert.equal(diagramBuilder(mt, '5365', O('PLUG,MACHINE THREAD')), 'plug');
  // a pipe plug with no length (real: 4730002783462) is not drawn
  assert.equal(buildDiagram(E({ 'NOMINAL THREAD SIZE': 'EXTERNAL INCHES 0.125' }), '4730', O('PLUG,PIPE')), null);
});

test('r4: setscrew refuses a socket wider than the screw or a thread longer than the screw', () => {
  const f = FX.setscrew.chars;
  assert.equal(buildDiagram(E({ ...f, 'WIDTH ACROSS FLATS': 'INCHES NOMINAL 0.250' }), '5305', O('SETSCREW')), null);
  assert.equal(buildDiagram(E({ ...f, 'THREAD LENGTH': 'INCHES NOMINAL 2.000' }), '5305', O('SETSCREW')), null);
  // real 5305000578455: thread length is a maximum, fastener length nominal
  const mx = E({ 'NOMINAL THREAD DIAMETER': 'INCHES 0.438', 'WIDTH ACROSS FLATS': 'INCHES NOMINAL 0.156', 'THREAD LENGTH': 'INCHES MAXIMUM 0.625', 'FASTENER LENGTH': 'INCHES NOMINAL 1.000' });
  const svg = buildDiagram(mx, '5305', O('SETSCREW'))!;
  assert.ok(svg.includes('0.625 MAX THREAD LG') && svg.includes('1.000 LG'));
  // a socket size is optional: the screw is drawn and says so
  const nosock = E({ 'NOMINAL THREAD DIAMETER': 'INCHES 0.164', 'FASTENER LENGTH': 'INCHES NOMINAL 0.500' });
  assert.match(buildDiagram(nosock, '5305', O('SETSCREW'))!, /SOCKET SIZE NOT STATED/);
  // other 5305 names keep their earlier behaviour
  assert.equal(buildDiagram(E(f), '5305', O('THUMBSCREW')), null);
});

test('r4: round nut needs one of thickness or height, never both, and a plain round form name', () => {
  const f = FX.roundnut.chars;
  const asHeight = { 'NOMINAL THREAD SIZE': f['NOMINAL THREAD SIZE'], 'NUT DIAMETER': f['NUT DIAMETER'], 'NUT HEIGHT': 'INCHES MINIMUM 0.365 AND INCHES MAXIMUM 0.385' };
  assert.match(buildDiagram(E(asHeight), '5310', O('NUT,SELF-LOCKING,ROUND'))!, /0\.365–0\.385 HEIGHT/);
  assert.equal(buildDiagram(E({ ...f, 'NUT HEIGHT': 'INCHES NOMINAL 0.5' }), '5310', O('NUT,PLAIN,ROUND')), null);
  assert.equal(buildDiagram(E(f), '5310', O('NUT,PLAIN,SPLINE')), null);
  assert.equal(buildDiagram(E({ ...f, 'NUT DIAMETER': 'INCHES NOMINAL 1.000' }), '5310', O('NUT,PLAIN,ROUND')), null);
});

test('r4: blind-rivet nut needs head and body sizes that make sense', () => {
  const f = FX.blindnut.chars;
  assert.equal(buildDiagram(E({ ...f, 'HEAD DIAMETER': 'INCHES NOMINAL 0.200' }), '5310', O('NUT,PLAIN,BLIND RIVET')), null);
  assert.equal(buildDiagram(E({ ...f, 'HEAD HEIGHT': undefined as unknown as string }), '5310', O('NUT,PLAIN,BLIND RIVET')), null);
  assert.ok(buildDiagram(E(f), '5310', O('NUT,SELF-LOCKING,BLIND RIVET')));
});

test('r4: self-aligning bearing: a rod end or any part with a shank or length keeps its earlier behaviour', () => {
  const f = FX.selfalign.chars;
  assert.notEqual(diagramBuilder(E(f), '3120', O('BEARING,PLAIN,ROD END')), 'selfalign');
  assert.notEqual(diagramBuilder(E({ ...f, 'OVERALL LENGTH': 'INCHES NOMINAL 1.9500' }), '3120', O('BEARING,PLAIN,SELF-ALIGNING')), 'selfalign');
  assert.notEqual(diagramBuilder(E({ ...f, 'OUTER MEMBER OUTSIDE DIAMETER': 'INCHES NOMINAL 0.3000' }), '3120', O('BEARING,PLAIN,SELF-ALIGNING')), 'selfalign');
});

test('r4: spacer plate lists what it leaves out and takes an optional thickness', () => {
  const f = { 'OVERALL LENGTH': 'INCHES NOMINAL 2.312', 'OVERALL WIDTH': 'INCHES NOMINAL 1.000', 'HOLE DIAMETER': 'INCHES NOMINAL 0.438', 'BOLT HOLE QUANTITY': '2', 'OVERALL THICKNESS': 'INCHES NOMINAL 0.125' };
  const svg = buildDiagram(E(f), '5365', O('SPACER,PLATE'))!;
  assert.ok(svg.includes('NOT DRAWN: HOLES') && svg.includes('0.125 THK') && svg.includes('EDGE VIEW'));
  const long = { 'OVERALL LENGTH': 'INCHES NOMINAL 33.750', 'OVERALL WIDTH': 'INCHES NOMINAL 1.250' };
  check(buildDiagram(E(long), '5365', O('SPACER,PLATE'))!);
  assert.equal(buildDiagram(E({ 'OVERALL LENGTH': 'INCHES NOMINAL 1.0' }), '5365', O('SPACER,PLATE')), null);
});

test('r4: Woodruff key refuses a height that no circular segment can have', () => {
  const f = FX.woodruff.chars;
  assert.equal(buildDiagram(E({ ...f, 'KEY HEIGHT': 'INCHES NOMINAL 2.000' }), '5315', O('KEY,WOODRUFF')), null);
  assert.equal(buildDiagram(E({ ...f, 'KEY HEIGHT': 'INCHES NOMINAL 0.100' }), '5315', O('KEY,WOODRUFF')), null);
  // real 5315014493793 has only diameter and thickness: no drawing
  assert.equal(buildDiagram(E({ 'CIRCLE DIAMETER': 'INCHES NOMINAL 0.740', 'THICKNESS': 'INCHES NOMINAL 0.1875' }), '5315', O('KEY,WOODRUFF')), null);
});

test('r4: an older builder that draws a part keeps drawing it (r4 only fills gaps)', () => {
  // a hexagon nut with flats stated is drawn by the nut builder, whatever r4 knows about round nuts
  const hex = E({ 'NOMINAL THREAD SIZE': 'INCHES 0.250', 'WIDTH ACROSS FLATS': 'INCHES NOMINAL 0.4375', 'NUT HEIGHT': 'INCHES NOMINAL 0.218' });
  const before = diagramBuilder(hex, '5310', O('NUT,PLAIN,HEXAGON'));
  assert.ok(before && !['roundnut', 'blindnut'].includes(before));
});

test('r4: extremes stay on the sheet', () => {
  const tiny = E({ 'NOMINAL THREAD DIAMETER': 'INCHES 0.060', 'FASTENER LENGTH': 'INCHES NOMINAL 0.250' });
  const s = buildDiagram(tiny, '5305', O('SETSCREW'));
  if (s) check(s);
  const big = E({ 'NOMINAL THREAD DIAMETER': 'INCHES 2.000', 'FASTENER LENGTH': 'INCHES NOMINAL 6.000' });
  check(buildDiagram(big, '5305', O('SETSCREW'))!);
  const longNip = E({ 'NOMINAL OVERALL LENGTH': 'INCHES 24.000', 'NOMINAL THREAD SIZE': 'ALL ENDS INCHES 4.000', 'NOMINAL PIPE SIZE ACCOMMODATED': 'ALL ENDS INCHES 4.000' });
  check(buildDiagram(longNip, '4730', O('NIPPLE,PIPE'))!);
  const wideNut = E({ 'NOMINAL THREAD SIZE': 'INCHES 3.094', 'NUT DIAMETER': 'INCHES MINIMUM 3.755 AND INCHES MAXIMUM 3.760', 'NUT THICKNESS': 'INCHES MINIMUM 0.718 AND INCHES MAXIMUM 0.720' });
  check(buildDiagram(wideNut, '5310', O('NUT,PLAIN,ROUND'))!);
});
