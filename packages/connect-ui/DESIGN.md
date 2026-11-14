---
version: alpha
name: HoBo Rubberhose
description: >
  Steamboat Willie / Cuphead / Fleischer-style rubberhose cartoon identity for
  HoBo's provider-connection pages (hobo ci up, hobo cd up). Thick ink
  outlines, hard sticker shadows, black-and-white day/night inversion, one
  spark accent for focus and errors — never flat SaaS chrome, never soft
  elevation. shadcn/ui components take the identity through CSS variables.
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
  soot: "#1a1512"
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
    letterSpacing: 0.08em
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
  "2xl": 64px
components:
  card:
    backgroundColor: "{colors.neutral-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: 24px
  banner-lamp-go:
    backgroundColor: "{colors.go}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.pill}"
  banner-lamp-spark:
    backgroundColor: "{colors.spark}"
    textColor: "{colors.on-tertiary}"
    rounded: "{rounded.pill}"
  banner-lamp-faint:
    backgroundColor: "{colors.faint}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.pill}"
  component-row:
    backgroundColor: "{colors.neutral-inset}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: 14px
  uptime-cell-go:
    backgroundColor: "{colors.go}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.sm}"
  uptime-cell-spark:
    backgroundColor: "{colors.spark}"
    textColor: "{colors.on-tertiary}"
    rounded: "{rounded.sm}"
  uptime-cell-unknown:
    backgroundColor: "{colors.border-strong}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
  page-surface:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: 24px
  hairline-soft:
    backgroundColor: "{colors.border}"
    textColor: "{colors.ink}"
  mascot-bo:
    backgroundColor: "{colors.soot}"
    textColor: "{colors.cream}"
  badge:
    backgroundColor: "{colors.neutral-inset}"
    textColor: "{colors.mute}"
    rounded: "{rounded.pill}"
    padding: 8px
  caption:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.faint}"
    typography: "{typography.label-caps}"
  code-block:
    backgroundColor: "{colors.code-bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: 16px
  link:
    textColor: "{colors.ink}"
  link-hover:
    textColor: "{colors.spark}"
  focus-ring:
    backgroundColor: "{colors.spark}"
  theme-night:
    backgroundColor: "{colors.night-bg}"
    textColor: "{colors.night-text}"
  theme-night-surface:
    backgroundColor: "{colors.night-raised}"
    textColor: "{colors.cream}"
---

## Overview

**Brand & Style:** HoBo status pages carry the **HoBo Rubberhose** identity
(ADR-0149) — the same ink-on-paper cartoon language as `site/DESIGN.md`.
A status page is an operational trust surface: it must read instantly
(githubstatus.com information density) while staying unmistakably HoBo
(sticker-shadow cards, Chewy headings, film grain, day/night inversion).

Tokens in this file are the authority for `src/tokens.ts`
(`STATUS_PAGE_TOKENS`); the design-lint test
(`test/status-page-design-lint.test.ts`) rejects any rendered hex outside
this palette.

## Aesthetic pillars

- **Ink on paper by day, paper on ink by night.** Exact inversion via
  `data-theme`, honoring `prefers-color-scheme` until the visitor picks.
- **Hard sticker shadows** (`4px 4px 0 ink`) on cards and pressables only.
  Never soft/Material/rgba elevation.
- **Thick ink outlines** — 3px solid borders on surfaces, 2px on small
  inline chrome (code, uptime cells). Never 1px hairlines.
- **Strict black-and-white, rare accents.** `go` green means operational,
  `spark` vermillion means trouble, `faint` gray means delayed/unknown or
  maintenance. No other accent colors, no SaaS blues.

## Status semantics

- **Lamps are inert, so lamps are flat.** The banner lamp and per-component
  left bands are not pressable and therefore never get the sticker shadow
  ("pressable = raised" law).
- **Delayed/unknown is `faint`, not green.** A component outside its
  freshness budget must visually read as unknown (gray band, "Delayed /
  unknown" state text) — the ADR-0077 fail-safe made visible.
- **Uptime bars** are 90 bounded cells: `go` for operational days, `spark`
  for degraded/outage days, `border-strong` for unknown/maintenance days.
  Each cell carries a `title` tooltip and the row an `aria-label`.

## Motion & accessibility

- Only tap/hover transforms on pressables; `prefers-reduced-motion: reduce`
  disables all motion and the film grain.
- Focus rings are 3px `spark` outlines with 3px offset.
- Sections are labelled by headings (`aria-labelledby`); the banner is a
  `role="status"` live region.

## Do's and Don'ts

- **Do** keep every hex in this file's palette; the lint test enforces it.
- **Do** escape every interpolated value (`escapeHtml`).
- **Don't** raise lamps, bands, or uptime cells with shadows.
- **Don't** introduce a fourth identity — this file restates HoBo
  Rubberhose; product truth lives in `site/DESIGN.md` (ADR-0149).
