# Emblems in the footer: what may be shown

Researched 2026-11-24 from official sources. Not legal advice. Nothing below has been published; the
footer ships with names in text only and an empty slot per institution (see "What ships today").

## Summary

- **No seal may be used.** Department of War (formerly Defense) and military department seals are for
  official use only, and the Great Seal and the President's seal are restricted by statute (18 U.S.C. 713).
- **Every service emblem needs prior written permission** from that service's trademark licensing office,
  and every office forbids use that implies endorsement of a non-federal entity. The Air Force guidance
  goes further: its marks may not be used to bolster a non-federal entity's online presence. A footer on a
  commercial, ad-supported site is close to exactly that, so expect refusals; the requests are still drafted.
- **Redrawing is the weakest point.** Offices require approved artwork; the Air Force forbids stretching and
  unauthorized colours; the DoW guide forbids creating logos that incorporate service marks. A
  consistent monochrome redraw is therefore *not* assumed allowed for any mark. Each request asks the
  question directly.
- **Names in plain text are fine** when they state a fact (whose buying the data covers) and carry a
  non-endorsement line. That is what ships.

## Table

| Institution | Mark considered | Rule and source | Permission needed? | Office to ask, form or address | Monochrome redraw allowed? |
|---|---|---|---|---|---|
| Department of War (DoD) | DoW seal | Seals are protected and may not be used for non-official purposes; no substitute mark for non-DoW use. https://www.war.gov/Resources/Trademarks/ | Not grantable (seal) | None; DoW Branding and Trademark Licensing Program (OATSW(PA)) lists no public request route | No |
| Department of the Army / U.S. Army | Army star logo (not the seal) | Army Trademark Licensing Program administers all Army, Army Reserve and National Guard marks and regulates all external uses. https://www.army.mil/ATLP ; DoW guide https://www.war.gov/Resources/Trademarks/DOD-Trademark-Licensing-Guide/ | Yes, prior written | Director, Army Trademark Licensing Program, 2530 Crystal Drive, Suite 4150, Arlington, VA 22202-3934; usarmy.trademark-licensing@army.mil | Not stated; ask. Guide forbids logos that incorporate service marks |
| Department of the Navy / U.S. Navy | Navy emblem / logo | Approval needed before use; site warns against pulling logos from the web; no licence for uses that suggest endorsement of a non-federal entity. https://www.navy.mil/TRADEMARKS/About-Us , https://www.navy.mil/TRADEMARKS/Trademark-License/ | Yes | Navy Trademark Licensing Office, Office of Naval Research, 875 N. Randolph Street, Suite W515A, Arlington, VA 22203; usn.pentagon.cnr-arlington-va.mbx.navylicensing@us.navy.mil; one-time-use form https://www.navy.mil/TRADEMARKS/Public-Use/ | Not stated; ask |
| U.S. Marine Corps | Eagle, Globe and Anchor | EGA, seal, initials and name are USMC property; permission required for commercial and advertising use. https://www.hqmc.marines.mil/Agencies/Counsel-for-the-Commandant/Marine-Corps-Trademark-Licensing-Program/Commercial-Use ; https://www.trademark.marines.mil/Frequently-Asked-Questions/ | Yes | Marine Corps Trademark Licensing Office, HQMC, 925 Corporate Drive, Ste 208, Stafford, VA 22554; 703-784-6887 | An approved line-art version exists in approved colours; graphics only on request and approval. Ask |
| Department of the Air Force / U.S. Air Force | Air Force Symbol | Registered mark; permission required for commercial use and advertising; only the Emblem (not the Seal) is licensable; marks may not bolster an NFE's online presence or imply endorsement; symbol may not be stretched or recoloured. https://www.trademark.af.mil/News/Photos/?igpage=2 , https://www.af.mil/Portals/1/documents/afbirthday/USE_OF_AF_MARKS_BY_NON-FEDERAL-ENTITIES.pdf | Yes; likely refused | Intellectual Property Management Office, Air Force Public Affairs Agency, 1960 1st Street West, Bldg. 977, Wing D101, JBSA-Randolph, TX 78150; licensing@us.af.mil; form https://www.trademark.af.mil/Public-Use-Authorization-Requests/ | Only approved colours; ask whether a one-colour format is approved |
| U.S. Space Force | Space Force logo (delta) | Managed by the same DAF office as the Air Force. https://www.war.gov/Resources/Trademarks/ | Yes; likely refused | Same office and form as the Air Force | Ask |
| U.S. Coast Guard (DHS) | Coast Guard emblem | Mark, emblem and name protected by 14 U.S.C. 639; emblem available only with a licence agreement; reproducing it for non-Coast Guard use needs Commandant approval (33 CFR 23.10). https://www.uscg.mil/Community/Trademark/ , https://www.law.cornell.edu/cfr/text/33/23.10 | Yes | Commandant (CG09231), Trademark Licensing Program, U.S. Coast Guard, 2703 Martin Luther King Ave SE Stop 7501, Washington, DC 20593-7103; trademarks@uscg.mil | Colour defined (PMS 179 C, 307 C); ask |
| National Guard Bureau | Guard marks | Army Guard marks fall under the Army Trademark Licensing Program (army.mil/ATLP); Air Guard under the DAF office. Source as above | Yes | Army and DAF offices above | Ask |
| Defense Logistics Agency | DLA emblem (seal-style: shield, DoD eagle, scroll) | DoW component; NFEs may not use seals, logos or insignia of a DoD component in association with their organisation (DoD standards-of-conduct material). No DLA public licensing route found | Unverified; treat as not grantable | DLA Public Affairs (ask in writing which office decides) | Unverified |
| General Services Administration | GSA Star Mark (and GSA Seal since 2026) | Star Mark may not be used without explicit written permission from the Office of Strategic Communication; materials may not imply endorsement. https://gsa.gov/node/83078 , https://www.gsa.gov/media-usage-guidelines | Yes | GSA Office of Strategic Communication (route via the GSA logo policy page) | Official artwork only; ask |
| Great Seal of the United States | Great Seal | 18 U.S.C. 713 restricts likenesses in advertising and in ways suggesting government sponsorship. https://uscode.house.gov/us/usc/t18/s713/ | Not grantable for this use | None | No |
| Presidential Seal | Seal of the President | 18 U.S.C. 713 (same); Executive Order 11649 | Not grantable | None | No |
| SAM.gov, DIBBS | Site logos | No public logo-licensing policy found; they are GSA and DLA systems, so the GSA and DLA rows apply | Treat as yes | GSA, DLA as above | No |

## Endorsement and the "Proudly serving" line

Every office above forbids use that implies endorsement, affiliation or sponsorship. A service emblem beside
"proudly serving" on a commercial site reads as a relationship the site does not have, so the line is
reworded and kept away from any mark (decision D-12 in `design/decisions.md`): the footer states a fact
about the data ("Public buying data from") and carries the line "Not affiliated with or endorsed by any
U.S. government agency or military service."

## What ships today

`web/src/lib/institutions.ts` lists each institution with `emblem: null`. The footer renders the names in
text, each in a fixed-size cell that has room for a 20 px mark. When a permission arrives, add the approved
artwork file to `web/public/emblems/`, set `emblem` and `approval` (office, date, reference) for that entry,
and the cell shows it. Nothing else changes, and layout does not shift.

## If monochrome is refused for a mark

The options to choose from then (not decided here): show that mark in its approved colours (breaks the
one-colour set but is allowed), show all marks in approved colours, or leave that institution as text only.

## Drafts

Permission requests for Peter to send are kept privately (claude.ai project doc `claude/emblem-permission-requests-2026-11-24.md` and the private docs repo), not in this public repository. Nothing has been sent.

## Not verified

The DoW Trademark Licensing Guide page and the 2017 DoD guide PDF could not be read in full by the
fetch tool; their content above comes from search extracts of the same official pages. DLA's own policy
on its emblem was not found.
