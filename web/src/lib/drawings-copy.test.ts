import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DRAWINGS_ANCHOR, EXPORT_CONTROL_NOTES, GUIDE_PATH, OFFICIAL_SOURCES, drawingsBlock, standardDocCounts, techDocsLineForPart } from './drawings-copy.ts';

const URL_ = 'https://www.dibbs.bsm.dla.mil/RFQ/RFQNsn.aspx?value=5340009990001&category=nsn';
const allText = (b: NonNullable<ReturnType<typeof drawingsBlock>>) =>
  [b.heading, b.badge, b.intro, b.noStandardsNote ?? '', ...b.notes, ...b.steps.flatMap((s) => [s.text, s.link?.label ?? ''])].join('\n');

test('SAM.gov notices get no block here (attachments are handled elsewhere)', () => {
  assert.equal(drawingsBlock('tech_docs', 'sam_gov', true, 'https://sam.gov/x'), null);
  assert.equal(drawingsBlock(null, 'sam_gov', false, 'https://sam.gov/x'), null);
});

test('Tech Docs: numbered official steps in order, export-control notes, standards shown only when on file', () => {
  const b = drawingsBlock('tech_docs', 'dibbs_rfq', false, URL_)!;
  assert.equal(b.kind, 'tech_docs');
  assert.equal(b.steps.length, 5);
  assert.deepEqual(b.steps.map((s) => s.link?.external), [true, true, true, true, true]);
  assert.equal(b.steps[0].link?.href, URL_);
  assert.match(b.steps[1].text, /AMPS/);
  assert.match(b.steps[2].text, /Okta/);
  assert.match(b.steps[3].link!.href, /^https:\/\/tdmt\.dla\.mil\/$/);
  assert.match(b.steps[4].text, /DD Form 2345.*Enhanced Validation/);
  assert.equal(b.showStandards, false);
  assert.equal(drawingsBlock('tech_docs', 'dibbs_rfq', true, URL_)!.showStandards, true);
  assert.ok(b.notes.some((n) => /outside the United States/.test(n)));
});

test('spec/standard only points at the part standard documents and ASSIST', () => {
  const withDocs = drawingsBlock('spec_only', 'dibbs_rfq', true, URL_)!;
  assert.equal(withDocs.showStandards, true);
  assert.equal(withDocs.noStandardsNote, null);
  assert.match(withDocs.intro, /defined by specifications and standards/);
  assert.match(withDocs.steps[1].text, /below/);
  const without = drawingsBlock('spec_only', 'dibbs_rfq', false, URL_)!;
  assert.match(without.noStandardsNote!, /No standard document number is on file/);
});

test('None: no claim about approved sources, only "read the solicitation"', () => {
  const b = drawingsBlock('none', 'dibbs_rfq', false, URL_)!;
  assert.match(b.intro, /DLA lists no technical data/);
  assert.doesNotMatch(allText(b), /approved source/i);
  assert.equal(b.steps[1].link?.href, GUIDE_PATH);
});

test('unknown flag: a block only when the part has standard documents', () => {
  assert.equal(drawingsBlock(null, 'dibbs_rfq', false, URL_), null);
  assert.equal(drawingsBlock(null, 'dibbs_rfq', true, URL_)!.showStandards, true);
});

test('copy has no em dashes or en dashes, and no promises about cost or waiting time', () => {
  for (const kind of ['tech_docs', 'spec_only', 'none', null] as const) {
    for (const has of [true, false]) {
      const b = drawingsBlock(kind, 'dibbs_rfq', has, URL_);
      if (!b) continue;
      assert.doesNotMatch(allText(b), /[–—]/, `${kind}/${has}`);
      assert.doesNotMatch(allText(b), /\bfree\b|\bwithin \d+ (days|weeks)\b/i);
    }
  }
  for (const n of EXPORT_CONTROL_NOTES) assert.doesNotMatch(n, /[–—]/);
});

test('official sources are https dla.mil / amps / aia pages with a date or an explicit null', () => {
  for (const s of Object.values(OFFICIAL_SOURCES)) {
    assert.match(s.url, /^https:\/\/(www\.dla\.mil|www\.dsp\.dla\.mil|amps1\.dla\.mil|aia-aerospace\.org)\//);
    assert.ok(s.pageDate === null || /^\d{4}-\d{2}-\d{2}$/.test(s.pageDate));
    assert.ok(s.establishes.length > 20);
  }
});

test('part page line: open Tech Docs solicitations only', () => {
  assert.equal(techDocsLineForPart([{ solNumber: 'A', status: 'expired', techDocs: 'tech_docs' }, { solNumber: 'B', status: 'open', techDocs: 'none' }, { solNumber: 'C', status: 'open', techDocs: 'spec_only' }]), null);
  const one = techDocsLineForPart([{ solNumber: 'SPE1', status: 'open', techDocs: 'tech_docs' }])!;
  assert.deepEqual([one.solNumber, one.count], ['SPE1', 1]);
  assert.match(one.text, /open solicitation SPE1\./);
  const two = techDocsLineForPart([{ solNumber: 'SPE1', status: 'open', techDocs: 'tech_docs' }, { solNumber: 'SPE2', status: 'open', techDocs: 'tech_docs' }])!;
  assert.match(two.text, /2 open solicitations of this part, such as SPE1/);
  assert.equal(DRAWINGS_ANCHOR, 'drawings');
});

test('standardDocCounts', () => {
  assert.deepEqual(standardDocCounts([{ access: 'assist' }, { access: 'adopted' }, { access: 'sold' }]), { assist: 2, sold: 1 });
});
