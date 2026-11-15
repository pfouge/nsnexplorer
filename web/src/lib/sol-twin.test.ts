import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ALSO_ON_SAM_LABEL, SAM_DUPES_CTE, SOLS_ONCE_SQL, SOL_KEY_FORMAT, isPairableKey, pickTwin, solKey, solKeySql, sourceLabel, twinLine,
} from './sol-twin.ts';
import * as mjs from '../../../shared/sol-twin.mjs';

const dibbs = (n: string) => ({ solNumber: n, source: 'dibbs_rfq', sourceUrl: 'https://www.dibbs.bsm.dla.mil/RFQ/RFQNsn.aspx?value=1&category=nsn' });
const sam = (n: string) => ({ solNumber: n, source: 'sam_gov', sourceUrl: 'https://sam.gov/opp/abc/view' });

test('solKey: dashes, spaces and case are dropped', () => {
  assert.equal(solKey('SPE4A5-26-T-1234'), 'SPE4A526T1234');
  assert.equal(solKey(' spe4a526t1234 '), 'SPE4A526T1234');
  assert.equal(solKey('SPE4A5 26 T 1234 --'), 'SPE4A526T1234');
  assert.equal(solKey(null), '');
});

test('isPairableKey: only DLA-shaped numbers', () => {
  assert.ok(isPairableKey('SPE4A526T1234'));
  assert.ok(isPairableKey('SPE7L126T13T3'));
  assert.ok(!isPairableKey('SPE4A526T123')); // one short
  assert.ok(!isPairableKey('SPE4A52XT1234')); // the year is two digits
  assert.ok(!isPairableKey('SPE4A5261234')); // no letter in the type position
  assert.ok(!isPairableKey('LOCALTESTREPOST1'));
  assert.ok(!isPairableKey(''));
});

test('pickTwin: one DIBBS and one SAM.gov row with the same key pair, from either side', () => {
  const rows = [dibbs('SPE4A5-26-T-1234'), sam('SPE4A526T1234')];
  assert.equal(pickTwin({ solNumber: 'SPE4A5-26-T-1234', source: 'dibbs_rfq' }, rows)?.solNumber, 'SPE4A526T1234');
  assert.equal(pickTwin({ solNumber: 'SPE4A526T1234', source: 'sam_gov' }, rows)?.solNumber, 'SPE4A5-26-T-1234');
});

test('pickTwin: three rows on one key (two SAM spellings) pair nothing', () => {
  const rows = [dibbs('SPE4A5-26-T-1234'), sam('SPE4A526T1234'), sam('spe4a526t1234')];
  assert.equal(pickTwin({ solNumber: 'SPE4A5-26-T-1234', source: 'dibbs_rfq' }, rows), null);
  assert.equal(pickTwin({ solNumber: 'SPE4A526T1234', source: 'sam_gov' }, rows), null);
});

test('pickTwin: two rows of the same source, a lone row, a non-DLA number and a foreign source pair nothing', () => {
  assert.equal(pickTwin({ solNumber: 'SPE4A5-26-T-1234', source: 'dibbs_rfq' }, [dibbs('SPE4A5-26-T-1234'), dibbs('SPE4A526T1234')]), null);
  assert.equal(pickTwin({ solNumber: 'SPE4A526T1234', source: 'sam_gov' }, [sam('SPE4A526T1234')]), null);
  assert.equal(pickTwin({ solNumber: 'LOCALTEST-REPOST-1', source: 'dibbs_rfq' }, [dibbs('LOCALTEST-REPOST-1'), sam('LOCALTESTREPOST1')]), null);
  assert.equal(pickTwin({ solNumber: 'SPE4A5-26-T-1234', source: 'dibbs_rfq' }, [dibbs('SPE4A5-26-T-1234'), { ...sam('SPE4A526T1234'), source: 'other' }]), null);
});

test('pickTwin: rows that do not contain the page row, or whose keys differ, pair nothing', () => {
  assert.equal(pickTwin({ solNumber: 'SPE4A5-26-T-1234', source: 'dibbs_rfq' }, [sam('SPE4A526T1234'), sam('SPE4A526T1235')]), null);
  assert.equal(pickTwin({ solNumber: 'SPE4A5-26-T-1234', source: 'dibbs_rfq' }, [dibbs('SPE4A5-26-T-1234'), sam('SPE4A526T1235')]), null);
});

test('twinLine: wording for each direction, no em dash', () => {
  assert.deepEqual(twinLine('sam_gov', 'SPE4A526T1234'), { prefix: 'Also posted on SAM.gov as', label: 'SPE4A526T1234' });
  assert.deepEqual(twinLine('dibbs_rfq', 'SPE4A5-26-T-1234'), { prefix: 'Also on DIBBS as', label: 'SPE4A5-26-T-1234' });
  assert.equal(sourceLabel('sam_gov'), 'SAM.gov');
  assert.ok(!/—/.test(ALSO_ON_SAM_LABEL + twinLine('sam_gov', 'x').prefix));
});

test('SQL: the plain-Node copy in shared/sol-twin.mjs produces identical strings', () => {
  assert.equal(mjs.SOL_KEY_FORMAT, SOL_KEY_FORMAT);
  assert.equal(mjs.solKeySql('t'), solKeySql('t'));
  assert.equal(mjs.SAM_DUPES_CTE, SAM_DUPES_CTE);
  assert.equal(mjs.SOLS_ONCE_SQL, SOLS_ONCE_SQL);
});

test('SQL: the key expression is the one migration 0016 indexes, and db/freshness.mjs uses the shared fragment', () => {
  const migration = readFileSync(new URL('../../../db/migrations/0016_solicitation_twin_key.sql', import.meta.url), 'utf8');
  const expr = solKeySql('x').replace('x.', '');
  assert.ok(migration.includes(`((${expr}))`), 'migration index expression drifted from solKeySql');
  const freshness = readFileSync(new URL('../../../db/freshness.mjs', import.meta.url), 'utf8');
  assert.equal(freshness.split('${SOLS_ONCE_SQL} s').length - 1, 2);
});

test('SQL: the CTE joins through the key and never uses a correlated EXISTS', () => {
  assert.ok(!/EXISTS/i.test(SAM_DUPES_CTE));
  assert.ok(SAM_DUPES_CTE.includes(`${solKeySql('d')} = sm.k`));
});
