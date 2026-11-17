---
version: alpha
name: HoBo Rubberhose
description: >
  Steamboat Willie / Cuphead / Fleischer-style rubberhose cartoon identity for
  the HoBo CI relay dashboard. Thick ink outlines, hard sticker shadows on
  pressables only, film grain, black-and-white day/night inversion, flat
  status lamps — never flat SaaS chrome, never soft elevation.
colors:
  primary: "#101010"
  on-primary: "#ffffff"
  secondary: "#4a4a46"
  tertiary: "#c5301c"
  on-tertiary: "#ffffff"
  neutral: "#ffffff"
  neutral-raised: "#ffffff"
  neutral-inset: "#f4f4f2"
  ink: "#101010"
  paper: "#ffffff"
  cream: "#f2f1ec"
  mute: "#4a4a46"
  faint: "#6e6d68"
  border: "#e3e2de"
  border-strong: "#c9c8c2"
  spark: "#c5301c"
  go: "#14672c"
  code-bg: "#f7f7f5"
  night-bg: "#0a0a0a"
  night-text: "#f2f1ec"
  night-raised: "#111111"
typography:
  h1:
    fontFamily: Chewy
    fontSize: 2.25rem
    fontWeight: 400
    lineHeight: 1.1
    letterSpacing: 0.01em
  h2:
    fontFamily: Chewy
    fontSize: 1.5rem
    fontWeight: 400
    lineHeight: 1.2
  h3:
    fontFamily: Chewy
    fontSize: 1.25rem
    fontWeight: 400
    lineHeight: 1.2
  body-md:
    fontFamily: system-ui
    fontSize: 1rem
    fontWeight: 400
    lineHeight: 1.65
  label-caps:
    fontFamily: system-ui
    fontSize: 0.75rem
    fontWeight: 700
    letterSpacing: 0.06em
  mono:
    fontFamily: ui-monospace
    fontSize: 0.875rem
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: 4px
  md: 12px
  lg: 18px
  pill: 999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 40px
components:
  card:
    backgroundColor: "{colors.neutral-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: 24px
  page-surface:
    backgroundColor: "{colors.cream}"
    textColor: "{colors.ink}"
  action:
    backgroundColor: "{colors.neutral-inset}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: 12px
  action-hover:
    backgroundColor: "{colors.spark}"
    textColor: "{colors.on-tertiary}"
    rounded: "{rounded.sm}"
  action-current:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.sm}"
  lamp-go:
    backgroundColor: "{colors.go}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.pill}"
  lamp-spark:
    backgroundColor: "{colors.spark}"
    textColor: "{colors.on-tertiary}"
    rounded: "{rounded.pill}"
  lamp-faint:
    backgroundColor: "{colors.faint}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.pill}"
  attention-row:
    backgroundColor: "{colors.neutral-inset}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: 10px
  table-frame:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
  table-rule:
    backgroundColor: "{colors.border}"
    textColor: "{colors.ink}"
  field:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: 8px
  trend-bar:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.sm}"
  badge:
    backgroundColor: "{colors.neutral-inset}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: 4px
  caption:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.mute}"
    typography: "{typography.label-caps}"
  code-chip:
    backgroundColor: "{colors.code-bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
  empty-state:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.mute}"
    rounded: "{rounded.lg}"
    padding: 16px
  focus-ring:
    backgroundColor: "{colors.spark}"
  inline-chip-rule:
    backgroundColor: "{colors.border-strong}"
  muted-lamp-ground:
    backgroundColor: "{colors.faint}"
  theme-night:
    backgroundColor: "{colors.night-bg}"
    textColor: "{colors.night-text}"
  theme-night-surface:
    backgroundColor: "{colors.night-raised}"
    textColor: "{colors.cream}"
---

## Overview

**Brand & Style:** the HoBo CI dashboard carries the **HoBo Rubberhose**
identity (ADR-0149), the same ink-on-paper cartoon language as
`site/DESIGN.md`, which stays the authority. The dashboard is an operational
surface someone opens when CI is slow, costly or stuck, so it reads like a
status page: what needs attention first, then the detail. It is read-only
(ADR-0183): the one control that leads to a change, the Router view's "Edit
in a pull request", is a link to GitHub's editor.

Tokens in this file are the authority for `src/tokens.ts`
(`DASHBOARD_TOKENS`); `test/design-lint.test.ts` rejects any other hex in the
page or a view.

## Aesthetic pillars

- **Ink on paper by day, paper on ink by night.** Exact inversion via
  `data-theme`, honouring `prefers-color-scheme` until the visitor picks.
- **Hard sticker shadows** (`4px 4px 0 ink`) on pressables only: the view
  links, buttons and the edit link. Cards carry the shadow as page sections.
- **Thick ink outlines.** 3px on surfaces, tables and fields; 2px on small
  inline chrome (code chips, lamps, trend bars). Never 1px hairlines.
- **Strict black and white, rare accents.** `go` green means working, `spark`
  vermillion means trouble or needs attention, `faint` gray means unknown,
  paused or waiting. No other accent, no SaaS blues.

## Status semantics

- **Lamps are inert, so lamps are flat.** A lamp always sits beside words
  that say the same thing, so colour is never the only signal.
- **Attention comes first.** The Runners view opens with what needs someone,
  worst first (offline, paused, full, on the host), each with a left `spark`
  band.
- **A broken order is an alert.** The Router view shows the parser's sentence
  in a `role="alert"` line and disables the what-if walk.
- **Diagnosis is evidence, not a verdict.** A failed job shows the sentence
  `summarizeDiagnosis` gives and the lines it rests on.

## Motion and accessibility

- Only tap and hover transforms on pressables; `prefers-reduced-motion:
  reduce` removes all motion and the film grain.
- Focus rings are 3px `spark` outlines with a 3px offset, on links, buttons,
  fields and `<main>`, which takes focus after a view loads.
- Every field has a `<label>`, every table a `<caption>` and column headers,
  every section a heading (`aria-labelledby`). Status lines are polite live
  regions; the trend chart has an `aria-label` and a `title` per day.
- Text colours meet WCAG AA (4.5:1) on their grounds by day and by night;
  the design-lint test computes the ratios.

## Do's and Don'ts

- **Do** keep every hex in this file's palette.
- **Do** escape every interpolated value (`escapeHtml`).
- **Don't** raise lamps, attention rows, tables, the diagnosis box or trend
  bars with shadows.
- **Don't** add a control that writes to the relay. A change is a commit to
  `.hobo/ci.json` made through a pull request.
- **Don't** show third-party logos. Runner types are named in text.
