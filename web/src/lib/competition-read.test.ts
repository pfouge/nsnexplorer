import { test } from 'node:test';
import assert from 'node:assert/strict';
import { competitionRead } from './competition-read.ts';

const aw = (date: string, cage: string | null) => ({ date, cage });
const seq = (cages: (string | null)[]) => cages.map((c, i) => aw(`2025-01-${String(20 - i).padStart(2, '0')}`, c)); // newest first

test('three or more distinct winners is contested', () => {
  const r = competitionRead({ coded: 'unknown', awards: seq(['A', 'B', 'C', 'A']) });
  assert.equal(r.label, 'Usually contested');
  assert.equal(r.tone, 'green');
  assert.equal(r.reason, '3 suppliers won the last 4 awards on record.');
  assert.equal(r.considered, 4);
  assert.equal(r.distinctWinners, 3);
});

test('two winners share it', () => {
  const r = competitionRead({ coded: 'open', awards: seq(['A', 'B', 'A']) });
  assert.equal(r.label, 'Two suppliers share it');
  assert.equal(r.tone, 'neutral');
  assert.equal(r.reason, '2 suppliers won the last 3 awards on record.');
});

test('one winner, with and without open coding', () => {
  const a = competitionRead({ coded: 'restricted', awards: seq(['A', 'A', 'A', 'A']) });
  assert.equal(a.label, 'One supplier keeps winning');
  assert.equal(a.tone, 'amber');
  assert.equal(a.reason, 'The same supplier won all 4 awards on record.');
  assert.equal(a.streak, 4);
  assert.equal(a.streakCage, 'A');
  const b = competitionRead({ coded: 'open', awards: seq(['A', 'A', 'A']) });
  assert.equal(b.reason, 'The same supplier won all 3 awards on record. The item is coded for competition.');
});

test('fewer than three awards uses the coding', () => {
  const open = competitionRead({ coded: 'open', awards: seq(['A', 'B']) });
  assert.equal(open.label, 'Coded for competition, little award history');
  assert.equal(open.tone, 'green');
  assert.equal(open.reason, '2 awards with a supplier are on record.');
  const res = competitionRead({ coded: 'restricted', awards: seq(['A']) });
  assert.equal(res.label, 'Coded for a named source');
  assert.equal(res.tone, 'amber');
  assert.equal(res.reason, '1 award with a supplier is on record.');
  const unk = competitionRead({ coded: 'unknown', awards: [] });
  assert.equal(unk.label, 'Not enough history');
  assert.equal(unk.tone, 'neutral');
  assert.equal(unk.reason, 'No awards with a supplier are on record.');
  assert.equal(unk.streak, 0);
  assert.equal(unk.streakCage, null);
});

test('only the 10 most recent awards count', () => {
  const cages = ['A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'B', 'C', 'D'];
  const r = competitionRead({ coded: 'unknown', awards: seq(cages) });
  assert.equal(r.considered, 10);
  assert.equal(r.distinctWinners, 1);
  assert.equal(r.streak, 10);
});

test('null and blank CAGEs are ignored', () => {
  const r = competitionRead({ coded: 'unknown', awards: seq([null, 'A', '', 'B', null, 'C']) });
  assert.equal(r.considered, 3);
  assert.equal(r.distinctWinners, 3);
  assert.equal(r.streak, 1);
  assert.equal(r.streakCage, 'A');
});

test('input order does not matter; streak counts from the newest award', () => {
  const awards = [aw('2024-01-01', 'B'), aw('2025-03-01', 'A'), aw('2025-02-01', 'A'), aw('2025-01-01', 'B')];
  const r = competitionRead({ coded: 'unknown', awards });
  assert.equal(r.streak, 2);
  assert.equal(r.streakCage, 'A');
});

test('date ties keep input order', () => {
  const r = competitionRead({ coded: 'unknown', awards: [aw('2025-01-01', 'X'), aw('2025-01-01', 'Y'), aw('2025-01-01', 'Y')] });
  assert.equal(r.streakCage, 'X');
  assert.equal(r.streak, 1);
  const r2 = competitionRead({ coded: 'unknown', awards: [aw('2025-01-01', 'Y'), aw('2025-01-01', 'X'), aw('2025-01-01', 'X')] });
  assert.equal(r2.streakCage, 'Y');
});

test('a run of three by the latest winner outweighs several distinct winners', () => {
  const awards = [
    { cage: 'AAAAA', date: '2026-10-30' },
    { cage: 'AAAAA', date: '2026-10-01' },
    { cage: 'AAAAA', date: '2026-09-01' },
    { cage: 'BBBBB', date: '2026-08-01' },
    { cage: 'CCCCC', date: '2026-07-01' },
  ];
  const r = competitionRead({ coded: 'restricted', awards });
  assert.equal(r.label, 'One supplier won the last 3');
  assert.equal(r.tone, 'amber');
  assert.equal(r.distinctWinners, 3);
  assert.equal(r.streak, 3);
  // A run of two does not trigger it.
  const r2 = competitionRead({ coded: 'unknown', awards: [awards[0], awards[1], awards[3], awards[4]] });
  assert.equal(r2.label, 'Usually contested');
});
