# Family

Product decisions for bringing family back. Everyone starts as an individual. A family is only a household you opt into — not an account, not a Self profile, and not a `personal` workspace flavor.

This slice replaces the previous family model (`kind: personal` promoted to `family`, manager-created ghost profiles, email-locked invites, manager/member roles as the join object).

## Who you are

- Every signed-in user starts solo. They are not linked to any family.
- A person is in at most one family: solo, or exactly one household.
- There are no ghost profiles. If someone does not have the app, they cannot be in the family and there is nothing to show.
- Health data is produced only by that person’s own app / HealthKit sync.

## Create

- A solo user names a family and creates it.
- The creator is the only creator of that family.
- Until someone joins, the household is a family of one.

## Invite

- Only the creator can mint invite links, from Manage Family.
- There is at most one live invite at a time.
- The link is one-time use: the first successful join consumes it.
- The link expires after one hour if unused.
- Creating a new link immediately kills any unused live link.
- Removing a member immediately kills any unused live link.
- How the creator shares the URL is out of scope. There is no email lock.
- The shareable URL is `https`. `familyos://invite/{token}` remains a fallback.
- Opening the link without the app shows a small web page (creator / family name, “Open in Family OS”). Join does not happen on the web.

## Join

Join never happens until a signed-in solo user hits save.

- The token is kept if the app opens while signed out; after sign-in, show the accept screen.
- Accept screen sentence: `{creator name} is my {label}`.
- Label is a closed list. No free text. No Other.

  Father, Mother, Husband, Wife, Partner, Son, Daughter, Brother, Sister, Grandfather, Grandmother, Grandson, Granddaughter

- Save creates two facts only:
  1. Membership in the creator’s family.
  2. One directed label from the joiner to the creator. No reverse label. No relationship to other members.
- Joining is the consent: every member can see everything the joiner has synced, including history, and everything they sync after that.
- Reject and do not join when:
  - the opener is already in a family (including this one)
  - it is their own invite
  - the token is expired, unknown, or already used

There is no manager/member role on join. Creator is a property of who created the family.

## See health

- The vitals view has a person switcher: yourself, or any member of this one family.
- History uses the same selected person. Not a second switcher.
- Selecting someone else is look-only. You cannot add, edit, or delete their samples, and you cannot run their HealthKit.
- Writes stay on your own person.

## Family tab (non-creator)

- Roster of display names.
- The label they picked (`{creator} is my Father`).
- Leave.
- No invite, no remove, no delete, no rename.

## Manage Family (creator)

- Roster of members.
- Create / copy the one live one-hour one-time invite.
- Remove a member (same outcome as that person leaving).
- Delete family — only when the creator is the only remaining member.

## Leave, remove, delete

- Any non-creator can leave when they want. They become solo. Their synced data stays theirs. They disappear from everyone else’s switcher immediately.
- The creator cannot leave.
- To become solo, the creator removes every other member, then deletes the family.
- No push notifications for join, leave, or remove. The roster updates the next time Family is opened.

## Out of scope

- More than one family per person.
- Ghost / dependent profiles without an account.
- Per-metric share toggles, or “only data from join onward.”
- Writing another member’s health.
- Inverse relationship labels, or relationships between non-creator members.
- Email-locked invites, multi-use live links, or more than one live link.
- Creator leave, creator transfer, or dissolve-while-members-remain.
- Join or accept on the web.
- Push for roster changes.
- App Store install-and-return as a required path.
- Renaming a family (not decided; not in this slice).
