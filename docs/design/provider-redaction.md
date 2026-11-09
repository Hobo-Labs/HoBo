---
type: Reference
title: "Provider Redaction"
description: "The one redactor for provider text, @hobo/provider-redaction: where it sits, why it is a leaf outside @hobo/core, and how each pattern is proved linear and never weaker than the copy it replaced."
tags: [hobo, design, security]
---

# Provider Redaction

Provider text (an API error body, CLI output, an apiserver Status, a host
fault) is hostile: it is whatever the other end sent, and the error path is the
one place it is read whole. Every provider, pack and guard that puts such text
in an error message, a log line or a receipt redacts it through one package,
`@hobo/provider-redaction`. The package README lists the shapes and the rules
they hold; this note records where the package sits and how it is held.

## Where it sits

- **A leaf.** It imports no HoBo package; the packages that redact provider
  text depend on it, and nothing else does.
- **Not in `@hobo/core`.** It started there as subpath exports. Main's push
  gate runs the whole suite of every dependent whose test script is not plain
  `vitest run` when one of its dependencies changes, so any change to a core
  file plans more than fifty whole suites; a change to a redaction shape should
  run the suites that redact.
- **Contract tier for the boundary gate.** Providers and packs are adapters,
  which may import only core ports and contract packages, so the package is
  registered in `CONTRACT_PACKAGE_PATHS` (`packages/conformance/src/boundaries.ts`)
  beside the vocabulary packages, for the same reason: it exists to be depended
  on.

## How it is held

- **Linear time.** Every pattern is swept (`/linear-sweep`): runs of every
  character class and every pair of them, and runs between the pattern's own
  literal fragments, ended by each terminator. Growth is measured in CPU time,
  never against a wall-clock bound (`/linear-time`).
- **Never weaker.** Each caller holds its redactor to the copy it replaced,
  vendored under its `test/fixtures`, on generated texts with secret markers
  (`/redaction-differential`): it may redact more, never less.
