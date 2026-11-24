// Institutions named in the site footer ("Public buying data from"). Names are plain text, which states
// a fact about the data. An emblem is shown only once that institution's trademark office has given
// written permission: put the approved artwork in web/public/emblems/, then set `emblem` (its path) and
// `approval` (office, date, reference). Rules and request drafts: design/emblems.md.
export interface Institution {
  name: string;
  emblem: string | null;
  approval: { office: string; date: string; reference: string } | null;
}

export const INSTITUTIONS: Institution[] = [
  { name: 'Defense Logistics Agency', emblem: null, approval: null },
  { name: 'U.S. Army', emblem: null, approval: null },
  { name: 'U.S. Navy', emblem: null, approval: null },
  { name: 'U.S. Marine Corps', emblem: null, approval: null },
  { name: 'U.S. Air Force', emblem: null, approval: null },
  { name: 'U.S. Space Force', emblem: null, approval: null },
  { name: 'U.S. Coast Guard', emblem: null, approval: null },
  { name: 'General Services Administration', emblem: null, approval: null },
];

export const NOT_ENDORSED = 'Not affiliated with or endorsed by any U.S. government agency or military service.';
