// Plain-language read of how contested an NSN has been, from its past awards.
// Pure: no imports, no I/O. Describes past awards, not eligibility.

export type CodedCompetition = 'open' | 'restricted' | 'unknown';

export interface AwardInput {
  cage: string | null;
  date: string;
}

export interface CompetitionRead {
  label: string;
  tone: 'green' | 'amber' | 'neutral';
  reason: string;
  considered: number;
  distinctWinners: number;
  streak: number;
  streakCage: string | null;
}

const WINDOW = 10;
const MIN_AWARDS = 3;

export function competitionRead(input: { coded: CodedCompetition; awards: readonly AwardInput[] }): CompetitionRead {
  const withCage = input.awards
    .map((a) => ({ date: a.date, cage: (a.cage ?? '').trim() }))
    .filter((a) => a.cage !== '');
  // Array.prototype.sort is stable: date ties keep input order.
  const recent = withCage.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, WINDOW);
  const considered = recent.length;
  const distinctWinners = new Set(recent.map((a) => a.cage)).size;
  const streakCage = considered > 0 ? recent[0].cage : null;
  let streak = 0;
  while (streak < considered && recent[streak].cage === streakCage) streak += 1;
  const base = { considered, distinctWinners, streak, streakCage };

  if (considered >= MIN_AWARDS) {
    if (distinctWinners >= 3) {
      return { ...base, label: 'Usually contested', tone: 'green', reason: `${distinctWinners} suppliers won the last ${considered} awards on record.` };
    }
    if (distinctWinners === 2) {
      return { ...base, label: 'Two suppliers share it', tone: 'neutral', reason: `2 suppliers won the last ${considered} awards on record.` };
    }
    return {
      ...base,
      label: 'One supplier keeps winning',
      tone: 'amber',
      reason: `The same supplier won all ${considered} awards on record.${input.coded === 'open' ? ' The item is coded for competition.' : ''}`,
    };
  }

  const on = `${considered} award${considered === 1 ? '' : 's'} with a supplier ${considered === 1 ? 'is' : 'are'} on record.`;
  const reason = considered === 0 ? 'No awards with a supplier are on record.' : on.charAt(0).toUpperCase() + on.slice(1);
  if (input.coded === 'open') return { ...base, label: 'Coded for competition, little award history', tone: 'green', reason };
  if (input.coded === 'restricted') return { ...base, label: 'Coded for a named source', tone: 'amber', reason };
  return { ...base, label: 'Not enough history', tone: 'neutral', reason };
}
