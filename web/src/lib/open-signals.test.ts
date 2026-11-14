import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAST_DUE_MAX_DAYS, PAST_DUE_MIN_DAYS, estimatedValue, inPastDueWindow, isPastDueUnawarded, lastUnitPrice, techDocsKind } from './open-signals.ts';

const TODAY = '2026-11-14';
const daysAgo = (n: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);

test('techDocsKind maps the DIBBS values, tolerant of case and whitespace', () => {
  assert.equal(techDocsKind('None'), 'none');
  assert.equal(techDocsKind('  none '), 'none');
  assert.equal(techDocsKind('Tech Docs'), 'tech_docs');
  assert.equal(techDocsKind('TECH  DOCS'), 'tech_docs');
  assert.equal(techDocsKind('Tech Docs *Spec/Stnd Only'), 'spec_only');
  assert.equal(techDocsKind(' tech docs *spec/stnd only '), 'spec_only');
  assert.equal(techDocsKind(null), null);
  assert.equal(techDocsKind(undefined), null);
  assert.equal(techDocsKind(''), null);
  assert.equal(techDocsKind('something else'), null);
});

test('window constants', () => {
  assert.equal(PAST_DUE_MIN_DAYS, 30);
  assert.equal(PAST_DUE_MAX_DAYS, 180);
});

test('inPastDueWindow boundaries at 29/30/180/181 days', () => {
  assert.equal(inPastDueWindow(daysAgo(29), TODAY), false);
  assert.equal(inPastDueWindow(daysAgo(30), TODAY), true);
  assert.equal(inPastDueWindow(daysAgo(180), TODAY), true);
  assert.equal(inPastDueWindow(daysAgo(181), TODAY), false);
  assert.equal(inPastDueWindow(TODAY, TODAY), false);
  assert.equal(inPastDueWindow('2026-12-01', TODAY), false);
});

const base = { status: 'expired', returnBy: daysAgo(60), awardFound: false };

test('isPastDueUnawarded: qualifying row and window boundaries', () => {
  assert.equal(isPastDueUnawarded(base, TODAY, '2026-07-01'), true);
  for (const [n, want] of [[29, false], [30, true], [180, true], [181, false]] as const) {
    assert.equal(isPastDueUnawarded({ ...base, returnBy: daysAgo(n) }, TODAY, '2026-01-01'), want, `${n} days`);
  }
});

test('isPastDueUnawarded: coverage floor', () => {
  const rb = daysAgo(60); // 2026-09-15
  assert.equal(isPastDueUnawarded({ ...base, returnBy: rb }, TODAY, rb), true);
  assert.equal(isPastDueUnawarded({ ...base, returnBy: rb }, TODAY, '2026-09-16'), false);
  assert.equal(isPastDueUnawarded({ ...base, returnBy: rb }, TODAY, null), false);
});

test('isPastDueUnawarded: awardFound, status and null inputs', () => {
  assert.equal(isPastDueUnawarded({ ...base, awardFound: true }, TODAY, '2026-07-01'), false);
  assert.equal(isPastDueUnawarded({ ...base, status: 'cancelled' }, TODAY, '2026-07-01'), false);
  assert.equal(isPastDueUnawarded({ ...base, status: 'open' }, TODAY, '2026-07-01'), false);
  assert.equal(isPastDueUnawarded({ ...base, status: 'awarded' }, TODAY, '2026-07-01'), false);
  assert.equal(isPastDueUnawarded({ ...base, returnBy: null }, TODAY, '2026-07-01'), false);
});

test('lastUnitPrice picks the most recent positive price', () => {
  assert.equal(lastUnitPrice([]), null);
  assert.equal(
    lastUnitPrice([
      { awardedOn: '2026-01-05', unitPrice: 10 },
      { awardedOn: '2026-03-01', unitPrice: 12.5 },
      { awardedOn: '2025-12-31', unitPrice: 99 },
    ]),
    12.5
  );
  assert.equal(
    lastUnitPrice([
      { awardedOn: '2026-01-05', unitPrice: 10 },
      { awardedOn: '2026-03-01', unitPrice: 0 },
      { awardedOn: '2026-04-01', unitPrice: -3 },
    ]),
    10
  );
  assert.equal(lastUnitPrice([{ awardedOn: '2026-03-01', unitPrice: 0 }]), null);
});

test('estimatedValue needs both inputs positive and rounds to cents', () => {
  assert.equal(estimatedValue(100, 2.5), 250);
  assert.equal(estimatedValue(3, 0.335), 1.01);
  assert.equal(estimatedValue(null, 5), null);
  assert.equal(estimatedValue(5, null), null);
  assert.equal(estimatedValue(0, 5), null);
  assert.equal(estimatedValue(5, 0), null);
  assert.equal(estimatedValue(-1, 5), null);
});
