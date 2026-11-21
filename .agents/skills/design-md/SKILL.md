---
name: design-md
description: Always verify visual, UI, TUI, and dashboard changes against implemented tokens with contrast, rendered-surface, and impeccable checks; never create design documents.
---

# Visual quality

## When to use

**Always, without being asked**, when changing visual behavior, UI, TUI, or
dashboards, including CSS, themes, design tokens, components, scenes, and
generated web UI. Do not wait for a design-lint or impeccable request.

## Implemented authority

Use the owning surface's implemented tokens and shared components. The reviewed
`scripts/visual-token-contract.json` contract binds the allowed palettes, and
`scripts/check-visual-tokens.mts` checks their contrast. Do not author or restore
`DESIGN.md` files or use `@google/design.md`.

## Required checks

1. Run impeccable `critique`, then `audit`, on the changed surface; polish any
   P0/P1 findings.
2. Run `pnpm run design:lint`. This must execute the implemented-palette
   contrast gate and fail closed for missing or unreadable palettes.
3. Run the affected package's design-lint and rendered-surface tests, including
   `status-page-design-lint` or `secret-capture-design-lint` when applicable.
4. Follow the owning package's documentation and evidence requirements.
