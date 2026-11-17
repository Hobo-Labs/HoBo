---
name: design-md
description: Google DESIGN.md visual identity for coding agents. HoBo truth is site/DESIGN.md (HoBo Rubberhose: Steamboat Willie/Cuphead ink-on-paper, thick ink outlines, hard sticker shadows, black and white with rare spark/go accents). Lint with designmd; pre-commit runs pnpm run design:lint for all web UI packages.
---

# design-md (HoBo)

## When to use

**Always, without being asked**, when the change is visual:

- Editing `site/` UI, CSS, scenes, or components
- Editing the status page HTML (`packages/status-page`) or control-yard (`packages/control-yard`)
- Generating UI that must match the public Pages aesthetic
- Changing design tokens or theme (light/dark inversion)
- Adding a new web UI package (must ship `DESIGN.md`)

Do not wait for “run design lint” or “use /impeccable”. Read the owning `DESIGN.md`, use its tokens/components, then run `pnpm run design:lint` plus the package design-lint tests before claiming done. Full standing rule: repo-root `AGENTS.md` → **Design system + lint**.

## Source of truth

| Artifact | Role |
|---|---|
| **`site/DESIGN.md`** | Public product identity (ADR-0149) |
| **`packages/status-page/DESIGN.md`** | Status page HTML |
| **`packages/control-yard/DESIGN.md`** | Control-yard only |
| **`pnpm run design:lint`** | Repo-wide gate — every web UI `DESIGN.md` (pre-commit + agent done-check) |

## Aesthetic (non-negotiable)

**HoBo Rubberhose** (ADR-0149) — Steamboat Willie/Cuphead ink on paper, thick outlines, hard sticker shadows, title-card lettering, and black-and-white day/night inversion with rare spark/go accents. **Art is sourced, never drawn in renderer code.** Bo and the rubberhose art bible are canonical.

### Do

- Ink (`#101010`) + paper (`#ffffff`) as the base language
- Spark vermillion only for focus / rare emphasis
- Squash-and-stretch motion; respect `prefers-reduced-motion`
- Keep night as token inversion of day

### Don't

- SaaS blues, purple AI glow, glassmorphism, multi-stop brand gradients
- Replace traced scenes with stock isometric / flat AI blobs
- Thin outlines below ~2px on primary chrome
- Pill `border-radius: 999px` buttons

## Web UI discovery

A package is a web UI if any of:

1. Path is `site/`
2. `"hobo": { "webUi": true }` in package.json
3. Depends on `astro` / `next` / `nuxt` / `@sveltejs/kit` / …
4. Already has a root `DESIGN.md`

Missing `DESIGN.md` on a web UI package **fails** `pnpm run design:lint`.

## CLI

```bash
pnpm run design:lint                             # ALL web UI DESIGN.md (pre-commit)
pnpm --filter hobo-site run design:lint          # site only
pnpm --filter hobo-site run design:export:css
pnpm --filter hobo-site run design:export:dtcg
pnpm --filter hobo-site run design:spec
```

Package: `@google/design.md` (bins `designmd` / `design.md`).

## Workflow

1. Read the **owning** `DESIGN.md` front matter + Overview before the first visual edit.
2. Use that package’s tokens and shared components. Do not invent hex or skip the component tree.
3. Run impeccable `critique` then `audit` on the files you changed (polish if P0/P1).
4. Run `pnpm run design:lint` and the package design-lint tests (`status-page-design-lint` when that surface moved). Pre-commit re-runs via `check:relevant:staged`; that does not replace the explicit lint.
5. Site content still follows `site/README.md` (base `/HoBo/`, no raw `docs/design/` links in prose).

## Spec

- Format: https://github.com/google-labs-code/design.md
- Stitch context (optional): https://stitch.withgoogle.com/
