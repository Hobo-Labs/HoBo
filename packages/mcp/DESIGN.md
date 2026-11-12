---
version: alpha
name: HoBo Rubberhose
description: >
  Steamboat Willie / Cuphead / Fleischer-style rubberhose cartoon identity for
  the HoBo secret-capture form. Thick ink outlines, one hard sticker shadow,
  black-and-white day/night inversion, rare accents — never flat SaaS
  chrome, never soft elevation.
colors:
  primary: "#101010"
  on-primary: "#ffffff"
  secondary: "#4a4a46"
  tertiary: "#c5301c"
  on-tertiary: "#ffffff"
  neutral: "#ffffff"
  neutral-inset: "#f4f4f2"
  ink: "#101010"
  paper: "#ffffff"
  cream: "#f2f1ec"
  mute: "#4a4a46"
  faint: "#6e6d68"
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
  capture-card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: 24px
  capture-field:
    backgroundColor: "{colors.neutral-inset}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: 8px
    typography: "{typography.mono}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.sm}"
    padding: 8px
    typography: "{typography.h3}"
  button-shadow:
    backgroundColor: "{colors.border-strong}"
    textColor: "{colors.ink}"
  caption:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.faint}"
    typography: "{typography.label-caps}"
  note:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.mute}"
  code-inline:
    backgroundColor: "{colors.code-bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
  error-rule:
    backgroundColor: "{colors.spark}"
    textColor: "{colors.on-tertiary}"
  stored-rule:
    backgroundColor: "{colors.go}"
    textColor: "{colors.on-primary}"
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

**Brand & Style:** the secret-capture form (`src/secret-capture/html.ts`) is
the one HoBo surface an owner sees in the middle of a deployment: a card that
asks for one secret, seals it in the window, and says where it was stored. It
carries the **HoBo Rubberhose** identity (ADR-0149) from `site/DESIGN.md`;
this file restates the subset of tokens it uses and is the authority for
`SECRET_CAPTURE_TOKEN_VALUES`. The design-lint test
(`test/secret-capture-design-lint.test.ts`) rejects any rendered hex outside
this palette.

It renders in two places that look alike on purpose: inside an MCP Apps
host's sandboxed frame (the `ui://hobo/secret-capture` resource), and as the
fallback page the HoBo MCP server serves on `127.0.0.1`. An owner who meets
both should recognise the second as the first.

## Aesthetic pillars

- **Ink on paper by day, paper on ink by night.** The host's
  `hostContext.theme` sets `data-theme`; the loopback page follows
  `prefers-color-scheme`. Night swaps `paper`/`ink` for `night-bg`/`night-text`
  and the field inset for `night-raised`.
- **Thick ink outlines.** The card is a 3px ink rule at `rounded.lg`; the
  field a 2px ink rule at `rounded.sm`.
- **One pressable, one sticker shadow.** "Store it" is `button-primary` (ink
  fill, Chewy label). Its hard offset shadow is `4px 4px 0 border-strong`
  (`button-shadow`), not ink, so it reads against the ink fill instead of
  merging with it. Nothing else is raised.
- **Spark and go stay rare.** Spark is the focus ring and the 4px rule beside
  an error; go is the 4px rule beside "Stored". Text stays ink in both, so
  the message keeps full contrast at night.
- **No network.** No web font, image or script is fetched: Chewy is named
  first and the system face takes over when the host has none. The MCP App
  resource declares empty `connectDomains` and `resourceDomains`.

## The form's copy

- Title: "Add <label>"; the secret's purpose under it; the field labelled
  "Value of `NAME`".
- The help line says what happens and what does not: encrypted in this window,
  written straight to the secret store, never shown to the agent, never shown
  here again.
- Success: "Stored in the secret store as `<ref>`. You can close this."
  Refusals name the reason (too short, wrong characters, wrong format), never
  the value.

## Motion & accessibility

- One motion: the button's press (`--dur-tap`, `--ease`), removed under
  `prefers-reduced-motion: reduce`.
- Focus rings are 3px `spark` outlines with 2px offset.
- Every field has a `<label>` and `aria-describedby` pointing at the help line
  and the error line; errors are `role="alert"`, the stored line is a polite
  `role="status"` region.
- One-line secrets are `type="password"`; multi-line ones (a PEM key) are a
  monospace textarea. Both carry `autocomplete="off"`,
  `autocapitalize="off"`, `autocorrect="off"` and `spellcheck="false"`, and
  the field is emptied the moment the value is sealed.

## Do's and Don'ts

- **Do** keep every hex in this file's palette; the lint test enforces it.
- **Do** set dynamic text with `textContent` only, and embed data as JSON
  that cannot close its `<script>` element.
- **Don't** load anything from the network, or send `ui/message` or
  `ui/update-model-context`: nothing the form holds goes in front of the
  model.
- **Don't** introduce another identity: product truth lives in
  `site/DESIGN.md` (ADR-0149).
