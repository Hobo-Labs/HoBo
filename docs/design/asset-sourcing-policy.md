---
type: Reference
title: "Asset Sourcing Policy for the Control Yard"
description: "Source classes, provenance rules, and license boundaries for HoBo visual assets."
tags: [hobo, design]
---

# Asset Sourcing Policy for the Control Yard

Governs every visual, audio, and font asset that ships in a HoBo surface. The
product surfaces (`site/` and `@hobo/control-yard`) use **HoBo
Rubberhose** under `site/DESIGN.md` and the owning package design contracts. See
[ADR-0149](./adr/07-portability-extensibility.md#adr-0149).

**Art is authored as art and vendored as assets.** Assembling props from
`rect`/`line` primitives inside a renderer is prohibited on every surface.

Two artifacts enforce the policy:

- **A per-surface provenance ledger** — every sourced or derived asset gets a
  row describing what it is, where it came from, its license, and any source
  work and timestamp used during production.
  - **Known gap:** `packages/control-yard/` ships art without a ledger.
- **[`scripts/check-licenses.ts`](../../scripts/check-licenses.ts)** — the
  `ALLOWED` SPDX allowlist gates inbound licenses repo-wide. Off-list asset
  licenses require the same explicit review-note process as dependencies.

## Source classes

### Public-domain reference and trace plates

Verify each work's US public-domain status before use. Record the source work,
year, and frame timestamp for every traced plate. Derive original characters
only: trademark rights survive copyright expiry, so recognizable protected
characters must not appear. Trace motion and construction, not identity. Bo and
the rubberhose art bible are canonical; historical traced material does not
ship without review.

### CC0 audio

CC0 audio is allowed for interaction feedback. Each pack or clip needs a
CREDITS.md row. Verify individual uploads rather than assuming a host site's
default license; CC-BY audio requires attribution and review.

### Fonts

Display and UI fonts must carry a permissive license on the allowlist. Vendor
the font and its license together; do not use CDN loading or converted formats
that strip license notices. Record each family in CREDITS.md.

### CC0 art

Vendored CC0 packs may be used directly with their upstream license files and a
CREDITS.md row. Disclose modifications in that row. Re-inked derivations name
their reference source.

### Disallowed without explicit review

- **CC-BY-NC, CC-BY-SA, or GPL art** — incompatible with the default allowlist;
  NC conflicts with the repository's outbound MIT posture and SA/GPL imposes
  additional obligations.
- **Raw marketplace drops** — purchased or bundled asset-store packs pasted in
  without provenance and license review.
- **AI-generated art outside the reviewed provenance pipeline** — generated
  output is only an intermediate until a human reviews the final asset and its
  provenance.

## Enforcement

- A surface change that adds or changes assets without matching provenance is
  incomplete.
- License questions resolve against the `ALLOWED` set in
  [`scripts/check-licenses.ts`](../../scripts/check-licenses.ts); additions need
  a dated review note.
- The owning DESIGN.md contract always wins a conflict with a sourced asset.
