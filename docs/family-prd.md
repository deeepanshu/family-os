# Family — PRD

Product contract: `docs/family.md`.

## Problem Statement

I use Family OS for my own health first. I also want a real household: I name a family, send a short-lived link, and the person who opens it joins as themselves — with their own app and their own synced data. After that we can each look at everyone else’s vitals.

The current product does not do that. Family is tangled up with a fake personal workspace, invites that change `kind` and lock on email, manager/member roles, and profiles I can create for people who never install the app. I cannot trust “add family” because the object on screen is not a household of real people.

## Solution

Everyone stays an individual until they create or join exactly one family.

A solo user names a household and becomes its creator. From Manage Family they mint one HTTPS invite link. That link is live alone, lasts one hour, and works once. They share it however they want.

The opener lands in the app (or a tiny web page that tells them to open the app). After sign-in, they see the creator’s name and pick a closed label: “{creator} is my Father” (or another value from the fixed list). Save puts them in that family and records that one directed label. Joining is the consent: every member can see everything each person has synced, history included.

Vitals (and History) gain a person switcher: me, or any member. Other people are look-only. I never type their blood pressure or run their HealthKit.

Non-creators get a Family tab: roster, the label they chose, Leave. The creator gets Manage Family: roster, the one invite, Remove, and Delete family only when they are the last person. The creator cannot Leave; they remove everyone, delete the family, and are solo again.

No ghost profiles. No app, no seat, no data.

## User Stories

1. As a signed-in new user, I want to use the app with no family at all, so that my health works before anyone else is involved.
2. As a solo user, I want to create a family by giving it a name, so that I have a household to invite people into.
3. As a solo user who just created a family, I want to be the only member until someone joins, so that I am not forced to add people I do not have yet.
4. As a solo user who is already in a family, I want Create Family to be unavailable, so that I cannot belong to two households.
5. As the family creator, I want a Manage Family surface, so that I can run the household without mixing that power into every member’s Family tab.
6. As the family creator, I want a button that creates an invite link, so that I can add a real person who already has (or will install) the app.
7. As the family creator, I want that link to expire after one hour, so that a leaked URL does not work forever.
8. As the family creator, I want the link to work only once, so that the first successful join consumes it.
9. As the family creator, I want only one live invite at a time, so that I always know which URL is the door.
10. As the family creator, I want creating a new link to kill the unused previous one, so that I can shut a link I already sent.
11. As the family creator, I want to copy the live link and see that it is still valid, so that I can share it in Messages or anywhere else without the app sending it for me.
12. As the family creator, I do not want to enter the other person’s email, so that sharing stays my problem and the link is enough.
13. As the family creator, I do not want to pick manager or member when inviting, so that join is not a role assignment.
14. As a non-creator member, I want no invite button, so that only the creator grows the family.
15. As someone who received a link, I want it to be an `https` URL, so that Messages and WhatsApp actually open something.
16. As someone who received a link and does not have the app, I want a small web page with the family or creator name and “Open in Family OS”, so that I know what I was invited to.
17. As someone on that web page, I want join to be impossible in the browser, so that membership only happens inside the signed-in app.
18. As someone who has the app, I want the same link to open Family OS, so that I land on the invite without pasting a token.
19. As someone whose client cannot open `https` into the app, I want a `familyos://invite/{token}` fallback to still work, so that existing custom-scheme handling is not wasted.
20. As someone who opens an invite while signed out, I want the token kept until I sign in, so that I do not lose the invite to the sign-in screen.
21. As a signed-in solo user with a valid invite, I want to see the creator’s name, so that I know who I am about to relate to.
22. As a signed-in solo user with a valid invite, I want to pick “{creator name} is my {label}” from a fixed list, so that I can say how I relate to them without typing.
23. As a joining user, I want the list to be only Father, Mother, Husband, Wife, Partner, Son, Daughter, Brother, Sister, Grandfather, Grandmother, Grandson, Granddaughter, so that every household uses the same labels.
24. As a joining user, I want no free-text and no Other, so that I pick the closest label or I do not join.
25. As a joining user, I want Save to put me in that family and store only that directed label, so that I am a member without inventing labels the other way around.
26. As a joining user, I want joining to mean everyone in the family can see everything I have already synced and everything I sync later, so that consent is one clear action.
27. As a joining user, I want the accept screen to say that in plain language, so that I am not surprised after Save.
28. As a user who is already in a family, I want an invite to refuse me, so that I am not silently moved or dual-homed.
29. As a user opening my own invite, I want it to refuse me, so that I cannot join my household as a second person.
30. As a user opening an expired, unknown, or already-used invite, I want a clear failure, so that I know the door is shut.
31. As a user who just joined, I want to appear on everyone else’s roster and person switcher, so that they can find me by my Self display name.
32. As a family member, I want to open vitals and switch to myself or any other member, so that I can look at the household’s health in the screens I already use.
33. As a family member, I want History to follow the same selected person, so that I do not have two different “who am I looking at” controls.
34. As a family member looking at someone else, I want their data to be read-only, so that I cannot fake or delete their samples.
35. As a family member, I want my own writes and HealthKit sync to stay on me, so that only my phone produces my data.
36. As a family member, I want to see everything another member has synced (all types the app already stores for them, including history), so that caregiving is not missing last month.
37. As a family member, I want people who never installed the app to be impossible to add, so that the roster is only people with real data.
38. As a non-creator, I want a Family tab with the roster, the label I chose for the creator, and Leave, so that I can see the household and get out.
39. As a non-creator, I want no remove, delete, rename, or invite on that tab, so that I cannot administer the household.
40. As a non-creator, I want Leave to make me solo immediately, so that I get my privacy back without waiting on the creator.
41. As a member who left, I want my synced data to stay mine, so that leaving does not delete my health.
42. As a remaining member, I want a person who left to vanish from my switcher the next time I load family state, so that I cannot keep viewing them.
43. As the creator, I want Remove to have the same outcome as that person leaving, so that I can take someone out of the household.
44. As the creator, I want Remove to kill any unused live invite, so that a kicked person cannot walk back in on the door I opened for someone else.
45. As a member who left (not kicked), I want an unused live invite to remain usable by someone else, so that my leaving does not block the next join.
46. As a removed or departed member, I want to need a new invite to come back, so that rejoin is an explicit creator action after a kick (and after a consumed one-time link).
47. As the creator, I want Leave to be unavailable, so that the household cannot lose its owner by accident.
48. As the creator, I want Delete family to stay disabled while anyone else is a member, so that I cannot blow up B and C by mistake.
49. As the creator who has removed everyone else, I want to delete the family and become solo, so that I can start over.
50. As a former creator after delete, I want my synced data to stay mine, so that deleting the household does not delete my health.
51. As any member, I do not want a push when someone joins, leaves, or is removed, so that this slice does not depend on notification plumbing.
52. As any member, I want the roster to be right the next time I open Family, so that refresh-on-open is enough.
53. As the creator, I want two children to both be able to pick Son or Daughter, so that the label list is not unique-per-family.
54. As a member, I want other members to appear by Self display name, not by an invented inverse label, so that I am not shown “Son” for someone who only said I am their Father.
55. As a solo user, I want bootstrap to keep working without a family, so that sign-in and Self setup do not require a household.
56. As a family member, I want my Self profile to remain my person, so that joining does not turn me into a profile someone else created.
57. As a user who is not the creator, I want creating an invite to be forbidden by the API, so that a crafted client cannot grow the family.
58. As a user who is not in the family, I want other members’ vitals to be forbidden, so that sharing is membership, not a guessable id.
59. As a user looking at another member, I want write APIs for their samples to be forbidden, so that look-only is enforced off-device.
60. As a tester, I want expired and already-used tokens to be distinct failures, so that the accept screen can explain the door.

## Implementation Decisions

- Family is only a named household created by a solo user. Do not create a family at bootstrap. Do not represent solo as `kind: personal`. Do not promote a personal row to family on first invite. If `kind` remains on the table for compatibility, new households are always a real family and the personal-switch path goes away.
- One active family membership per user. Create family and accept invite both fail when the actor already has an active membership.
- Creator is the user who created the family (`createdByUserId`). Invite, remove, and delete are creator-only. Do not use manager/member role as the join object or the invite payload. Existing role columns may stay internally if needed; the product does not assign a role on join.
- Self stays user-owned. Joining adds membership. Do not create a second person row for the joiner. Do not offer “add another health profile” as the way to add family. Creating unlinked people is not part of this slice.
- The relationship from grilling is a directed join label: joiner → creator, closed enum, grammar “{creator display name} is my {label}”. It is not the old free-text `relationshipLabel` on a manager-created profile. Store it on the membership (or a join-edge that is 1:1 with that membership). Do not write an inverse label. Do not create labels between non-creator members.
- Closed enum: Father, Mother, Husband, Wife, Partner, Son, Daughter, Brother, Sister, Grandfather, Grandmother, Grandson, Granddaughter. Reject anything else.
- Invite store changes: no required email, no role on the invite. One pending invite per family. TTL one hour. Status values still cover pending, accepted, revoked, expired. First successful accept marks it accepted and no second accept can succeed. Creating a new invite revokes the unused live one. Removing a member revokes the unused live one. Leave does not revoke the live invite.
- Accept requires a signed-in solo user and the chosen label. Preview (unauthenticated GET by token) returns enough to render the accept or landing page: family name, creator display name, status, expiry. It does not accept. It does not leak other members.
- Shareable URL is HTTPS, path carrying the token. Custom scheme `familyos://invite/{token}` remains a fallback. The iOS app already parks a pending invite token from those URLs and must also parse the HTTPS invite path the same way, then show accept after sign-in.
- New family lifecycle operations: leave (non-creator), remove member (creator), delete family (creator, and only when no other active members remain). Leave and remove make that user solo; their Self and synced samples stay; they disappear from member lists and switchers. Delete removes the household after it is empty of everyone but the creator (who then has no membership).
- Health visibility: any active member may read every stored health surface the app already exposes for any other active member of the same family, including history. Writes, deletes, and HealthKit runs stay on the caller’s own Self. Authorize by membership + target person’s linked user, not by “I created this profile.”
- Person switcher is a selected member id shared by vitals and History. Default to Self. If the selected member leaves or is removed, fall back to Self.
- Family tab vs Manage Family is a client split from the same current-family + members + live-invite payload. Creator sees manage actions; others see roster, their label, Leave.
- No push for roster changes in this slice. Clients refresh family state when those screens appear.
- Public invite landing (no app) is a small page only: identity + open-in-app. No accept there.
- Solo-first bootstrap, current family, and member list remain the load path. Extend them with creator identity, directed labels, and live invite summary for the creator. Do not invent a second bootstrap.
- In-memory and Postgres family stores must implement the same invite and membership rules. Existing tests that encode personal-kind promotion, email-locked invites, and manager-created extra profiles must change to match this PRD.

## Testing Decisions

A good test asserts what a caller can observe: HTTP status, envelope, who is in the family, whether a token still works, whether another member’s samples are readable or writable. It does not assert table shapes, `kind` flips, or which helper revoked the row.

**Primary seam (prefer this one):** the health HTTP app used today — authenticated requests against families, invites, bootstrap, people, and health read/write, with the in-memory family repository. That is the same seam as the existing family, invite, and solo-first bootstrap suites. Drive the new behavior there end-to-end (create → mint link → preview → accept with label → list members → read other member’s synced samples → forbid writes → leave / remove / delete / reject cases).

**Keep, do not add a parallel harness:**

- Same HTTP seam for expiry, one-live-link, one-time use, kick-revokes-invite, leave-does-not-revoke, already-in-a-family, own-invite, creator-cannot-leave, delete-blocked-while-members-remain.
- iOS tests at the existing bootstrap view-model / URL seam (already covers `familyos://invite/...` and `familyos://open?invite=...`): pending token from HTTPS invite URLs, accept screen only after signed-in solo, Family vs Manage actions from membership/creator, switcher selection shared by vitals and History, look-only for non-self.
- Postgres repository tests only where persistence or constraints can diverge from in-memory (one pending invite, TTL, unique active membership, revoke on remove). Not a second product spec.

Do not add a browser suite for the landing page beyond “it does not call accept.”

## Out of Scope

- More than one family per person.
- Ghost or dependent profiles without an account.
- Per-metric share toggles, or sharing only data from join time onward.
- Writing, editing, or deleting another member’s health; running their HealthKit.
- Inverse relationship labels, or relationships between non-creator members.
- Email-locked invites, multi-use links, or more than one live invite.
- Creator leave, creator transfer, or deleting a family while others remain.
- Accept or join on the web.
- Push notifications for join, leave, or remove.
- App Store install-and-return as a required path.
- Renaming a family.
- Rebuilding reminders, MCP, or audit as a new product; they must not reintroduce ghost profiles or personal-kind, but expanding them is not this PRD.

## Further Notes

Decisions were locked in a grilling session and written to `docs/family.md`. This PRD is that contract plus seams and stories for implementation.

The previous family implementation is considered wrong. Prefer replacing invite and membership behavior over preserving personal-workspace promotion.

Issue tracker publish was skipped on request; this file is the PRD.
