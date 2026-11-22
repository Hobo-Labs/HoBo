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

Use the owning surface's implemented tokens and shared components. The retired
`DESIGN.md` gate migrated to `pnpm run design:lint`, which executes
`scripts/check-visual-tokens.mts` against the reviewed
`scripts/visual-token-contract.json`. The checker fails closed for every
contract-listed UI project when its directory, manifest, palette, or required
contrast is missing or unreadable. New web UI packages must register their
palette and contrast pairs in the contract; do not author or restore `DESIGN.md`
files or use `@google/design.md`.

`test/visual-tokens.test.ts` proves real-site discovery, contract-wide
fail-closed behavior, and `DESIGN.md`/contract routing to `design:lint`.
Rendered-surface requirements live beside their owning packages and are enforced
by `packages/mcp/test/secret-capture-design-lint.test.ts`,
`packages/connect-ui/test/connect-ui-design-lint.test.ts`, and
`packages/status-page/test/status-page-design-lint.test.ts`.

## Required checks

1. Run impeccable `critique`, then `audit`, on the changed surface; polish any
   P0/P1 findings.
2. Run `pnpm run design:lint`. This must execute the implemented-palette
   contrast gate and fail closed for missing or unreadable palettes.
3. Run the affected package's design-lint and rendered-surface tests, including
   `status-page-design-lint` or `secret-capture-design-lint` when applicable.
4. Follow the owning package's documentation and evidence requirements.
