// ingest/sam/map-sam.test.mjs
// node:test suite for mapSamRecord (map-sam.mjs), against a synthetic SAM
// Opportunities API v2 record — no live API or DB calls.
//
// Run: node --test ingest/sam/map-sam.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapSamRecord } from './map-sam.mjs';

function baseRecord(overrides = {}) {
  return {
    noticeId: 'abc123def456',
    title: 'Widget Assembly, Type III',
    solicitationNumber: 'SPE1C1-26-Q-9999',
    fullParentPathName: 'DEPT OF DEFENSE.DEFENSE LOGISTICS AGENCY.DLA LAND AND MARITIME',
    organizationType: 'OFFICE',
    postedDate: '2026-07-10',
    type: 'Solicitation',
    responseDeadLine: '2026-08-01T14:00:00-04:00',
    active: 'Yes',
    classificationCode: '5331',
    typeOfSetAside: 'SBA',
    uiLink: 'https://sam.gov/opp/abc123def456/view',
    ...overrides,
  };
}

test('mapSamRecord: maps a normal open opportunity to a canonical row', () => {
  const rec = baseRecord();
  const result = mapSamRecord(rec);
  assert.ok(!result.skip, `expected a mapped row, got skip: ${result.skip}`);

  const { row } = result;
  assert.equal(row.sol_number, 'SPE1C1-26-Q-9999');
  assert.equal(row.nomenclature, 'Widget Assembly, Type III');
  assert.equal(row.issued_on, '2026-07-10');
  assert.equal(row.return_by, '2026-08-01'); // date-only, time/offset dropped
  assert.equal(row.status, 'open');
  assert.equal(row.source, 'sam_gov');
  assert.equal(row.source_url, 'https://sam.gov/opp/abc123def456/view');
  assert.equal(row.nsn, null);
  assert.equal(row.fsc, '5331');
  assert.equal(row.setaside, 'SBA');
  assert.equal(row.buyer_office, 'DEPT OF DEFENSE.DEFENSE LOGISTICS AGENCY.DLA LAND AND MARITIME');
  assert.equal(row.raw, rec); // raw is the exact same object reference passed in
});

test('mapSamRecord: falls back to organizationType when fullParentPathName is absent', () => {
  const rec = baseRecord({ fullParentPathName: undefined });
  const result = mapSamRecord(rec);
  assert.ok(!result.skip);
  assert.equal(result.row.buyer_office, 'OFFICE');
});

test('mapSamRecord: active === "No" maps to status expired', () => {
  const result = mapSamRecord(baseRecord({ active: 'No' }));
  assert.ok(!result.skip);
  assert.equal(result.row.status, 'expired');
});

test('mapSamRecord: a classificationCode that is not a 4-char PSC-like code maps fsc to null', () => {
  const result = mapSamRecord(baseRecord({ classificationCode: '70' }));
  assert.ok(!result.skip);
  assert.equal(result.row.fsc, null);
});

test('mapSamRecord: missing classificationCode maps fsc to null', () => {
  const result = mapSamRecord(baseRecord({ classificationCode: undefined }));
  assert.ok(!result.skip);
  assert.equal(result.row.fsc, null);
});

test('mapSamRecord: missing/blank solicitationNumber is skipped with reason no-sol', () => {
  assert.equal(mapSamRecord(baseRecord({ solicitationNumber: undefined })).skip, 'no-sol');
  assert.equal(mapSamRecord(baseRecord({ solicitationNumber: '' })).skip, 'no-sol');
  assert.equal(mapSamRecord(baseRecord({ solicitationNumber: '   ' })).skip, 'no-sol');
});

test('mapSamRecord: missing/blank uiLink is skipped with reason no-url', () => {
  assert.equal(mapSamRecord(baseRecord({ uiLink: undefined })).skip, 'no-url');
  assert.equal(mapSamRecord(baseRecord({ uiLink: '' })).skip, 'no-url');
});

test('mapSamRecord: responseDeadLine without a time component still maps cleanly', () => {
  const result = mapSamRecord(baseRecord({ responseDeadLine: '2026-08-01' }));
  assert.ok(!result.skip);
  assert.equal(result.row.return_by, '2026-08-01');
});

test('mapSamRecord: missing responseDeadLine maps return_by to null', () => {
  const result = mapSamRecord(baseRecord({ responseDeadLine: undefined }));
  assert.ok(!result.skip);
  assert.equal(result.row.return_by, null);
});
