import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDiagram, buildThumbnail, diagramBuilder } from './diagram.ts';
import { parseMeasure } from './diagram-kit.ts';

type Fx = { fsc: string; name: string; chars: Record<string, string> };
const E = (o: Record<string, string>) => Object.entries(o).map(([requirement, reply]) => ({ mrc: null, requirement, reply }));
const O = (name: string) => ({ nsnDashed: '0000-00-000-0000', itemName: name });

const FX: Record<string, Fx> = {
  bolt: { fsc: '5306', name: 'BOLT,MACHINE', chars: { 'NOMINAL THREAD DIAMETER': 'INCHES  0.190', 'FASTENER LENGTH': 'INCHES  MINIMUM  0.615 AND INCHES  MAXIMUM  0.635', 'HEAD HEIGHT': 'INCHES  MINIMUM  0.248 AND INCHES  MAXIMUM  0.268', 'WIDTH BETWEEN FLATS': 'INCHES  NOMINAL  0.250', 'THREAD LENGTH': 'INCHES  MINIMUM  0.523 AND INCHES  MAXIMUM  0.610' } },
  rivet: { fsc: '5320', name: 'RIVET,BLIND', chars: { 'SHANK DIAMETER': 'INCHES NOMINAL 0.156', 'FASTENER LENGTH': 'INCHES MAXIMUM 0.273', 'HEAD MAJOR DIAMETER': 'INCHES MINIMUM 0.296 AND INCHES MAXIMUM 0.328', 'HEAD HEIGHT': 'INCHES MINIMUM 0.067 AND INCHES MAXIMUM 0.077', 'GRIP LENGTH': 'INCHES MINIMUM 0.063 AND INCHES MAXIMUM 0.125' } },
  bearing: { fsc: '3110', name: 'BEARING,BALL,ANNULAR', chars: { 'OVERALL WIDTH': 'INCHES MINIMUM 0.4281 AND INCHES MAXIMUM 0.4331', 'BORE DIAMETER': 'INCHES MINIMUM 0.5903 AND INCHES MAXIMUM 0.5906', 'OVERALL OUTSIDE DIAMETER': 'INCHES MINIMUM 1.3775 AND INCHES MAXIMUM 1.3780' } },
  seal: { fsc: '5330', name: 'SEAL,PLAIN ENCASED', chars: { 'OUTSIDE DIAMETER': 'INCHES NOMINAL 11.258', 'ACCOMMODATED SHAFT DIAMETER': 'INCHES NOMINAL 5.875', 'SEAL WIDTH': 'INCHES NOMINAL 0.625' } },
  shim: { fsc: '5365', name: 'SHIM', chars: { 'OUTSIDE DIAMETER': 'MILLIMETERS NOMINAL 41', 'APERTURE DIAMETER': 'MILLIMETERS NOMINAL 32', 'OVERALL THICKNESS': 'MILLIMETERS NOMINAL 3' } },
  retaining: { fsc: '5325', name: 'RING,RETAINING', chars: { 'OUTSIDE DIAMETER': 'INCHES MINIMUM 2.672 AND INCHES MAXIMUM 2.742', 'MAJOR THICKNESS': 'INCHES MINIMUM 0.075 AND INCHES MAXIMUM 0.081' } },
  loop: { fsc: '5340', name: 'CLAMP,LOOP', chars: { 'MATERIAL THICKNESS': 'INCHES  NOMINAL  0.0468', 'LOOP WIDTH': 'INCHES  NOMINAL  0.50', 'LOOP INSIDE DIAMETER': 'INCHES  NOMINAL  2.00', 'CENTER TO CENTER DISTANCE BETWEEN LOOP AND MOUNTING HOLE': 'INCHES  NOMINAL  1.50' } },
  key: { fsc: '5315', name: 'KEY,MACHINE', chars: { 'OVERALL LENGTH': 'INCHES NOMINAL 3.500', 'OVERALL HEIGHT': 'INCHES NOMINAL 0.620', 'OVERALL WIDTH': 'INCHES NOMINAL 0.620' } },
};

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
  test(`${k}: drawing, thumbnail agree and geometry is inside the sheet`, () => {
    const e = E(f.chars);
    const svg = buildDiagram(e, f.fsc, O(f.name));
    assert.ok(svg, 'drawn');
    assert.equal(diagramBuilder(e, f.fsc, O(f.name)), k === 'bolt' ? 'bolt' : k);
    assert.ok(buildThumbnail(e, f.fsc, f.name), 'thumbnail');
    check(svg!);
    assert.match(svg!, /REFERENCE ONLY, NOT FOR MANUFACTURE/);
  });
  test(`${k}: returns null when an essential dimension is missing`, () => {
    for (const drop of Object.keys(f.chars)) {
      const rest = { ...f.chars };
      delete rest[drop];
      const svg = buildDiagram(E(rest), f.fsc, O(f.name));
      const th = buildThumbnail(E(rest), f.fsc, f.name);
      assert.equal(!!svg, !!th, `drawing/thumbnail parity without ${drop}`);
      if (svg) check(svg);
    }
    assert.equal(buildDiagram([], f.fsc, O(f.name)), null);
    assert.equal(buildThumbnail([], f.fsc, f.name), null);
  });
}

test('dimension text is the catalog text', () => {
  const b = buildDiagram(E(FX.bolt.chars), '5306', O('BOLT,MACHINE'))!;
  for (const t of ['0.615–0.635 FASTENER LG', '0.248–0.268 HEAD H', '0.523–0.610 THREAD LG', '⌀0.190', '0.250 A/F']) assert.ok(b.includes(t), t);
  assert.ok(buildDiagram(E(FX.rivet.chars), '5320', O('RIVET,BLIND'))!.includes('0.273 MAX FASTENER LG'));
  const m = buildDiagram(E(FX.shim.chars), '5365', O('SHIM'))!;
  assert.ok(m.includes('⌀41') && m.includes('⌀32') && m.includes('3 THK') && m.includes('MILLIMETERS'));
});

test('ambiguous or qualified values are not drawn', () => {
  const c = { ...FX.seal.chars, 'SEAL WIDTH': 'EXTERNAL INCHES NOMINAL 0.625' };
  assert.equal(buildDiagram(E(c), '5330', O('SEAL,PLAIN ENCASED')), null);
  const dup = E(FX.key.chars).concat(E({ 'OVERALL LENGTH': 'INCHES NOMINAL 9.000' }));
  assert.equal(buildDiagram(dup, '5315', O('KEY,MACHINE')), null);
  const mixed = { ...FX.seal.chars, 'SEAL WIDTH': 'MILLIMETERS NOMINAL 16' };
  assert.equal(buildDiagram(E(mixed), '5330', O('SEAL,PLAIN ENCASED')), null);
});

test('shapes that are not a straight head-and-shank are not drawn as one', () => {
  assert.equal(buildDiagram(E(FX.bolt.chars), '5306', O('BOLT,EYE')), null);
  assert.equal(buildDiagram(E(FX.bolt.chars), '5305', O('SCREW,SET')), null);
});

test('parseMeasure', () => {
  assert.equal(parseMeasure('MILLIMETERS NOMINAL 19')?.text, '19');
  assert.equal(parseMeasure('INCHES MAXIMUM 0.875')?.text, '0.875 MAX');
  assert.equal(parseMeasure('43.85 MILLIMETERS MINIMUM AND 44.95 MILLIMETERS MAXIMUM')?.text, '43.85–44.95');
  assert.equal(parseMeasure('EXTERNAL INCHES 0.875')?.qualifier, 'EXTERNAL');
  assert.equal(parseMeasure('INCHES NOMINAL 0.003 AND INCHES NOMINAL 0.063'), null);
});

test('extremes: 0.06 in x 12 in pin-like bolt and a fat stub stay on the sheet', () => {
  const thin = { 'NOMINAL THREAD DIAMETER': 'INCHES 0.060', 'OVERALL LENGTH': 'INCHES NOMINAL 12.000' };
  const fat = { 'NOMINAL THREAD DIAMETER': 'INCHES 2.000', 'OVERALL LENGTH': 'INCHES NOMINAL 0.500', 'HEAD HEIGHT': 'INCHES NOMINAL 0.300', 'HEAD DIAMETER': 'INCHES NOMINAL 3.000', 'THREAD LENGTH': 'INCHES NOMINAL 0.300' };
  for (const c of [thin, fat, { ...thin, 'HEAD HEIGHT': 'INCHES NOMINAL 0.05', 'GRIP LENGTH': 'INCHES NOMINAL 9' }]) {
    for (const [fsc, nm] of [['5306', 'BOLT,MACHINE'], ['5307', 'STUD,CONTINUOUS THREAD']]) {
      const svg = buildDiagram(E(c), fsc, O(nm));
      if (svg) check(svg);
    }
  }
  const rv = buildDiagram(E({ 'SHANK DIAMETER': 'INCHES NOMINAL 0.060', 'FASTENER LENGTH': 'INCHES NOMINAL 12', 'GRIP LENGTH': 'INCHES NOMINAL 11', 'HEAD HEIGHT': 'INCHES NOMINAL 0.03' }), '5320', O('RIVET,SOLID'));
  if (rv) check(rv);
  const ring = buildDiagram(E({ 'OUTSIDE DIAMETER': 'INCHES NOMINAL 12', 'INSIDE DIAMETER': 'INCHES NOMINAL 11.9', 'THICKNESS': 'INCHES NOMINAL 0.06' }), '5330', O('GASKET'));
  assert.ok(ring); check(ring!);
  const shim = buildDiagram(E({ 'OUTSIDE DIAMETER': 'INCHES NOMINAL 0.2', 'APERTURE DIAMETER': 'INCHES NOMINAL 0.05', 'OVERALL THICKNESS': 'INCHES NOMINAL 4' }), '5365', O('SHIM'));
  assert.ok(shim); check(shim!);
  const key = buildDiagram(E({ 'OVERALL LENGTH': 'INCHES NOMINAL 12', 'OVERALL WIDTH': 'INCHES NOMINAL 0.06', 'OVERALL HEIGHT': 'INCHES NOMINAL 0.06' }), '5315', O('KEY,MACHINE'));
  if (key) check(key);
});
