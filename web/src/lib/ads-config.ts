// The advertising switch file: the one place that holds the AdSense publisher id, the flag
// for in-page ad units, and (later) the ad unit slot ids. Nothing else in the site source may
// contain a publisher id; public/ads.txt carries the same digits and ads.test.ts keeps the
// two in step.
//
// Ads are on. Content pages carry the AdSense script and the units placed with
// components/AdUnit.astro. Consent (layouts/BaseLayout.astro): advertising consent is granted by
// default outside the EEA, UK and Switzerland unless the browser sends Global Privacy Control;
// inside them it stays denied until Google's consent message (AdSense > Privacy & messaging)
// grants it. Auto ads for this site are limited in AdSense to in-page banners: anchor,
// vignette, side rail and ad intents are off.

/** "ca-pub-" + 16 digits. Empty string switches every tag off. */
export const ADSENSE_CLIENT = 'ca-pub-9671575911691889';

/** In-page ad units. On since AdSense approved the site. Set false to remove every unit. */
export const AD_UNITS_ON = true;

/** Ad unit slot ids from AdSense (Ads > By ad unit), one per position so earnings report by position. Created 2026-11-20. */
export const AD_SLOTS = {
  top: '5881576041', // nsn_top, display
  mid: '3737582259', // nsn_mid, display
  low: '1460396564', // nsn_low, display
  article: '7006955455', // nsn_article, in-article
  multiplex: '4891928008', // nsn_multiplex, multiplex
} as const;
