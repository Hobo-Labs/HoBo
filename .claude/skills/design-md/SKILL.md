---
name: design-md
description: Apply implemented visual tokens for site, status-page, control-yard, and connection UI; run design lint and impeccable critique without creating design documents.
---

# Visual quality (implemented tokens)

Use this skill on edits under `site/`, `packages/status-page/`,
`packages/control-yard`, `packages/connect-ui` chrome, palette or theme token
files, and any new browser-facing package. Do not invent hex colors, SaaS-blue
accents, glassmorphism, or pill radii; traced art only; spark (`#c5301c`) and go
(`#14672c`) stay rare.

The authoritative token sheet for the public site is `site/src/styles/global.css`.
Connection UI palettes ship in `packages/connect-ui/src/client/connect.css`.
Status page and secret-capture colors are asserted by their package tests.

After visual edits:

1. Run `pnpm run design:lint`.
2. Run the package rendered-surface tests that cover your files (for example
   `packages/status-page/test/status-page-design-lint.test.ts`).
3. Run impeccable `critique` then `audit` on the changed surface; `polish` when
   they report P0/P1 issues.

Repository rules still prohibit creating or retaining design documents. Do not
invoke plugin commands that generate them.