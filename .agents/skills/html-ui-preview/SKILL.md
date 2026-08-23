---
name: html-ui-preview
description: Always share an HTML mock of UI changes first so DJ can give feedback. Use when changing iOS/app UI, History/Home/Family screens, layout, typography, icons, rows, sheets, or any visual surface.
---

# HTML UI preview before app changes

Never implement or restyle app UI first. Open a real HTML mock in the user's browser, wait for DJ's feedback, then implement.

## When this applies

Any change that a user can see:

- New screens, rows, sheets, tabs, empty states
- Layout, hierarchy, typography, icons, chips, tables
- Copy placement (title vs metric vs time)
- Visual density or grouping

Does not apply to non-visual work: API, models, sync, tests, docs.

## Loop

1. **Mock first.** Write a phone-width HTML file that matches the proposed surface. Use the existing app chrome (profile line, segmented filter, grouped cards, tab bar) so the mock is comparable.
2. **Open it.** `open` the file in the user's default browser. Do not rely on a headless screenshot as the review surface.
3. **Stop.** Tell DJ what to look at and wait. Do not start Swift/UI implementation in the same turn.
4. **Revise the HTML** until DJ says the layout is right.
5. **Then implement** the approved mock in the app. Do not invent extra visual ideas during the port.

## Mock rules

- Show real sample data, not lorem.
- Missing fields stay omitted; do not leave empty cells.
- Match current product vocabulary (Blood Pressure, Steps, Sleep, workout type names).
- Keep muted labels smaller than values.
- Type titles are words (`Blood Pressure`, `Running`), not icons, unless DJ asked for icons.

## Hard stops

- Do not edit SwiftUI / iOS view files until DJ approved the HTML.
- Do not treat "looks fine to me" from a headless screenshot as approval.
- If DJ changes the mock, update HTML and re-open before coding.
