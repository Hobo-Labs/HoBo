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

- **Its test harness is test-only, and a leaf of its own.** The linear-time
  measure, the sweep and the differential live in `@hobo/redaction-test-harness`
  (`/linear-time`, `/linear-sweep`, `/redaction-differential`), which every
  caller takes as a devDependency and no runtime code imports. They take what
  they search with as an argument, so the harness depends on nothing, and they
  are not in `@hobo/contract-harness`: every package's tests depend on that one,
  `@hobo/core` among them, so a change to it plans their whole suites.
- **Fan-out.** The conformance evidence gate keeps its own linear detectors
  rather than import this package, so a redaction change does not reach the
  runtimes that depend on conformance.

## How it is held

- **Linear time.** Every pattern is swept (`/linear-sweep`): runs of every
  class it reads (its alphabet is read from its own classes) and every pair of
  them, runs between its literal fragments ended by each terminator, each
  fragment over and over, and periodic texts. Each input is screened against
  the fastest of 32 linear scans of its length (under 32 of those is linear;
  quadratic patterns cost 160 or more), and an input above that is measured as
  growth in CPU time, never against a wall-clock bound (`/linear-time`).
- **ASCII case folding.** No shape sets both `i` and `u`: under `iu`,
  `[A-Za-z]` also holds `ſ` and `K`, and a look-behind refused a credential
  after one. Body classes list those two themselves, the look-behind that
  starts a run holds the same class as the run, and the one `u` shape spells its
  words with `anyCase`.
- **Never weaker.** Each caller holds its redactor to the copy it replaced,
  vendored under its `test/fixtures`, on generated texts with secret markers
  (`/redaction-differential`): it may redact more, never less. A key ends only
  on an END line written as keys write it, as every copy ended it.
- **Two tiers.** `test` runs the fast tier on every change: unit cases, every
  leak and hostile input a review found as a fixed input, and a differential at
  5k texts, which every earlier review round's leaking state fails. `test:deep`
  runs the sweeps, the growth measurements and the full-size differentials, 50k
  texts on three seeds (`*.deep.test.ts`).
- **Once per behaviour.** Six providers whose own rule was a long token run
  share `LONG_TOKEN_RUN_PROFILE`, tested once here; each tests only its
  wrapper.
