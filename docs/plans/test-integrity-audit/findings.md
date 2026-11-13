---
type: Review Findings
title: "Test integrity audit"
description: "What running every test file actually found: five defects that no gate was catching, and why the gates missed them."
tags: [hobo, plan, testing]
---

# Test integrity audit

Prompted by three questions: is coverage high across all test types and packages,
were the issues found along the way fixed, and was planned work finished. The
answer to the first was **unmeasurable** — `vitest.config.ts` carried
`coverage: { enabled: false }` and no coverage provider was installed at all, so
no coverage number for this repo had ever existed.

## Why the gates were not catching these

Three mechanisms combined:

1. **The pre-commit hook runs only *affected* packages.** A commit touching
   `packages/core` never runs `packages/recipes`.
2. **CI has been dark since 2026-08-01T03:41:52Z** — the last run on `main` was
   cancelled, and the runs before it failed. So the full matrix, which *would*
   have caught these, has not run in seventeen days.
3. **Some suites only pass in their per-package working directory**, so a
   root-level run and the turbo lane disagree about whether they are green.

Every failure below predates this session and reproduces on clean `main`.

## Fixed

| # | Package | Defect | Root cause |
|---|---|---|---|
| 1 | `packages/recipes` | 12 golden tests failing on trunk | `profileRegistryDigest` changed when the capability-profile catalog grew; goldens were never regenerated. **Topology output is byte-identical** — only the digest of the registry it resolved against moved, so nothing about what gets deployed changed. |
| 2 | `packages/schema-tools` | `hobo-codegen --check` exited DRIFT | Three generated bindings were never committed: `actor_host_port_pb.ts`, `cloud_provider_port_pb.ts`, `extension_plugin_pb.ts` — all three ADR-0156's ports. The protos landed without their generated output. |
| 3 | `packages/cli` | every scaffold typecheck "failed" | `typescriptCliPath()` did `path.resolve(process.cwd(), "..", "..")`, which is the repo root only when run from `packages/cli`. From the repo root it resolved `/home/node_modules/typescript/bin/tsc` and reported a missing binary as a type error. Now resolved through the module graph. |
| 4 | `packages/code` | 4 `it.skip` tests, no reason given | They asserted a replaced TUI layout — a `▣ n` nodes panel, a `◈ b` budget panel, an `▣ pl` platform verb. `budget` became `cost`; `nodes` and `platform` stopped being verbs; `agent` *became* one, so the test asserting its absence was wrong rather than merely stale. Replaced with the three invariants that outlived the layout. |
| 5 | `packages/code` | Playwright suite red on every host with a browser-revision mismatch | It honoured `PLAYWRIGHT_CHROMIUM_PATH` but nothing else, so a host carrying chromium 1194 against a playwright pinned to 1234 died on a missing `chrome-headless-shell` and reported it as a test failure. Now discovers a usable browser: env var, then playwright's own `executablePath()`, then the browsers-path symlink. A red test meaning "wrong browser build" teaches nobody anything. |

Finding 2 is the interesting one: ADR-0156 also had no row in `traceability.md`
(fixed separately in #1122). The same change landed incompletely in two
different places, which is what an unrun gate looks like from the outside.

## A second gate, and a mess this audit made

Running every test file writes `test/output/**` — generated fixtures that
`.gitignore` covers but `biome.json` did not, since its `files.includes` carries
`test/**` and it has no VCS ignore-file setting. So the sweep left artifacts
behind that then failed the formatter on the next commit. Artifacts removed, and
`!test/output/**` added to `biome.json` so a future sweep cannot repeat it.

## Attempted and withdrawn

`src/draft/…/s0-04-protobuf-cue-codegen` runs its **frozen** generator against
the **live** repo root and asserts CLEAN, so it fails permanently once the repo
grows a schema that generator predates. Scoping it to the proof's own tree — as
every other test in that file already does — looked like the fix, and the
`promoted-proof-drift` guard rejected it: *frozen proofs are read-only after
promotion; make changes in the canonical package* (AGENTS.md). The guard is
right and the edit is reverted.

The canonical package **is** fixed (finding 2 made `packages/schema-tools`
report CLEAN), but that does not clear this proof, because its frozen generator
is older than the current one and reports drift against the live tree whatever
the tree contains. Resolving it properly means either re-promoting the proof or
recording an exclusion in the promotions ledger — a `draft`-skill workflow, not
something to improvise inside a test-fixing pass. **Left failing, deliberately,
with the reason recorded.**

## Deliberately not "fixed"

- **`runtime-celld` `live-*` suites fail when `CELLD_BIN` is absent.** That is a
  policy, not a defect: *"Missing binary is a failure"* is the explicit message.
  A live lane that silently skips proves nothing.
- **`packages/componentize/test/real-componentize.integration.test.ts`** fails
  under vitest's thread pool (`stdio` is not a real descriptor in a worker).
- **`external/pixel-agents`, `external/ts-autocode`** are vendored third-party
  trees, not HoBo packages.

The coverage lane excludes `live-*` and `*.integration.test.ts` for this reason.

Finding 5 was found the hard way: it is what failed the first attempt to commit
findings 1-4, on a suite this audit had already written off as environmental.
"Environmental" was right about the cause and wrong about the remedy.

## Coverage, now measurable

`@vitest/coverage-v8` is installed and `pnpm run test:coverage` runs
`vitest.coverage.config.ts` — a separate lane, so the ordinary test paths keep
`coverage: { enabled: false }` and stay fast. It is scoped to first-party
`packages/*/src`; the root config's default discovery also sweeps `external/`,
`src/draft/`, `site/`, and generated `.optimizexp/` suites, and counting those
as HoBo package coverage would produce a number that means nothing.

**No threshold is set yet, deliberately.** A threshold picked before the first
honest measurement is a number invented to be met.

## A gate improved on the way through

Committing finding 2 tripped `generated:guard`, which requires generated output
to change alongside a `.proto`/`.cue`/`.wit` or generator edit. That staged-source
rule is a **proxy** for the property that matters — "generated output matches its
sources" — and the proxy cannot express a catch-up commit that only emits output
for a schema which landed earlier. Exactly this case.

Rather than widen it into an allowlist, the guard now verifies the real property
for protobuf outputs: it runs the codegen checker, and accepts the commit only
when that reports `CLEAN`. Falsified before landing — appending one line to a
generated file makes the checker report `DRIFT` and the guard exits 1; restoring
the file returns it to 0.
