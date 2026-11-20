// The advertising switch file: the one place that holds the AdSense publisher id, the flag
// for in-page ad units, and (later) the ad unit slot ids. Nothing else in the site source may
// contain a publisher id; public/ads.txt carries the same digits and ads.test.ts keeps the
// two in step.
//
// Phase 1 (now): the site is submitted to AdSense for review. Content pages carry the
// google-adsense-account meta tag and the AdSense script so Google can verify and review the
// site. No ad shows: AD_UNITS_ON is false and every ad consent signal defaults to denied
// (see the Consent Mode block in layouts/BaseLayout.astro).
// Phase 2 (after AdSense shows the site as "Ready"): fill AD_SLOTS, set AD_UNITS_ON to true,
// update the privacy page first, then change the consent defaults.

/** "ca-pub-" + 16 digits. Empty string switches every tag off. */
export const ADSENSE_CLIENT = 'ca-pub-9671575911691889';

/** In-page ad units. Off until the site is approved. */
export const AD_UNITS_ON = false;

/** Ad unit slot ids from AdSense (Ads > By ad unit), one per position. Empty until phase 2. */
export const AD_SLOTS = {
  top: '', // nsn_top, display
  mid: '', // nsn_mid, display
  low: '', // nsn_low, display
  article: '', // nsn_article, in-article
  multiplex: '', // nsn_multiplex, multiplex
} as const;
