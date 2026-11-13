---
type: Delivery State
title: "sdlc-state: consolidate-duplication"
description: "Durable state for the duplication-consolidation stack: layer topology, corrections to my own estimates, per-layer findings, and the where-it-stops list."
tags: [hobo, plan, testing]
---

# sdlc-state: consolidate-duplication

**Phase:** dispatch (parent-implemented; no subagent offload authorised)
**Trunk:** `main` @ `618129362`

**Tooling deviation:** `gh` is unavailable in this environment, so `gh stack` cannot be used.
Stack topology is plain git — each layer branches off the one below — and PRs are opened via
the GitHub MCP with an explicit `base`, which is the shape `gh stack submit` produces.
`gh stack sync` is replaced by an explicit `git rebase --onto` when a lower layer moves.

## Corrections carried into this plan

Two of my own estimates were wrong. Both are recorded because the measurement is the point:

| Claim | First estimate | Measured | Why the first was wrong |
|---|---|---|---|
| provider `manifest.ts` duplication | ~1,500 lines | **321 byte-identical** | `sed 's/aws/PROV/gi'` also rewrote unrelated substrings |
| pixel-village ↔ control-yard | 18,236 lines | **515 text lines** | `wc -l` counted PNG keyframes as lines |

## Layers

| # | Branch | Scope | State |
|---|---|---|---|
| 00 | `claude/consolidate-00-green-trunk-boundaries` | Make the boundary gate actually run | **done** — PR #1115 |
| 01 | `claude/consolidate-01-core-manifest-utils` | Manifest codec into `@hobo/core` + pinning tests | **done** — PR #1116 |
| 02 | `claude/consolidate-02-migrate-provider-manifests` | aws/azure/gcp/lakebed/convex onto it | **done** (−356) |
| 03 | ~~`claude/consolidate-03-migrate-runner-manifests`~~ | blacksmith/depot/github | **cancelled — not duplication** |

### Layer 00 — why it exists, and why it is the bottom

Not planned. Found when layer 01's gates were run against a clean main checkout: `lint:boundaries`
did not fail, it **crashed**. `parseWorkspaceEdge` throws on a workspace path it cannot classify,
and `listPackageJsonFiles` recursed unboundedly for any `package.json` under `packages/` — so it
swept up things that are not workspace packages at all (`packages/code/examples/*`,
`packages/hobo/fixtures/deploy/vercel`, the scaffolding templates under
`packages/patterns/patterns/*`), hit the first one, and aborted.

**An aborted gate is indistinguishable from a clean one** to anything that only reads an exit code.
Trunk had no boundary enforcement whatsoever, and had not for some time: 15 real workspace packages
were also unclassified, including `packages/bindings` and `packages/status-page`.

Fixed at the cause — discovery now reads the `pnpm-workspace.yaml` globs (the only authority on
what a workspace package is), scoped to the caller's root so it does not widen into `src/draft/**`.

With the gate finally running it reported **36 real violations across 8 provider packages** —
layer-2 adapters importing layer-3 packages directly. Those are banked in
`ACCEPTED_ADAPTER_PACKAGE_EDGES` (18 unique edges) rather than fixed here: restructuring eight
providers is not this initiative, and banking is the same ratchet shape `lint:budget` already uses
for biome. **The list should only ever shrink.**

Out of this stack, each its own follow-up: the 18 banked provider edges; `pixel-village` ↔
`control-yard` (515 lines, needs a package-edge decision, not a code move); the 8 provider
transports onto core's `guardTransport`.

## Log

- 00: gate repaired, 14+1 packages classified, 18 edges banked, regression test added and falsified
  (removing one entry names it). `violations: []` across 261 discovered edges.
- 01: codec added to `@hobo/core` as a pure addition; nothing migrated yet, so this layer cannot
  change any published manifest. 18 pinning tests, with `canonicalJson`/`stableDigest` literals
  captured from the pre-move provider implementation so a "tidier" rewrite fails here rather than
  at a consumer. Baseline bytes for all five providers captured out-of-tree for layer 02 to diff
  against.
- 02: five providers migrated, net −356 lines. Verified by capturing all 20 published documents
  (5 providers x 4) before and after and diffing: **byte-identical**. The comparator was itself
  falsified by perturbing one byte, which it detected. convex keeps its own parser (it genuinely
  differs) and shares only the helpers.

## Layer 03 was cancelled, and the reason is the useful part

The three runners (`runner-blacksmith`, `runner-depot`, `runner-github`) share a byte-identical
23-line helper block, which is how a hash-based duplicate scan grouped them and how they ended up
in this plan as "46 removable lines". Reading the block before migrating it showed the grouping was
right and the conclusion was wrong:

| Helper | Providers (`920f2c1d`) | Runners (`b4ea7026`) |
|---|---|---|
| `canonicalJson` | same | same |
| `sortKeys` | same (untyped) | same (generic `<T>`) |
| `digestRef` | `fnv:` — the non-cryptographic FNV-ish walk | **`sha256:` via `node:crypto`** |
| `stableDigest` | present | **absent** |

`digestRef` is **a different algorithm wearing the same name**. Migrating the runners onto core's
version would rewrite every digest reference they publish from `sha256:…` to `fnv:…` — exactly the
silent-breakage class that layer 01's pinning tests exist to prevent, and it would have been
delivered under a line-count win.

What is actually shared is `canonicalJson` plus `sortKeys`, roughly 36 lines across three files.
Taking it would mean exporting `sortKeys` from `@hobo/core` as public surface, because each runner
still needs it for its own sha256 digest. Widening a layer-0 package's API to save ~36 lines in
three layer-2 packages is a bad trade, so the runners are left alone.

### The finding worth escalating

Two different digest algorithms are in use inside the **same document family**. Providers publish
`fnv:` references in `/.well-known/capability-manifest/cost.json`; runners publish `sha256:` ones.
A consumer verifying a reference has to know which kind of package produced it.

The runners are almost certainly the ones that are right. `stableDigest`'s own comment calls itself
"deterministic non-cryptographic" and "not a security primitive", and a 32-bit FNV-ish walk has
collisions well within reach for an attacker who controls document content — and these documents
come from a provider-controlled origin.

**This is not fixable by a refactor.** Changing the providers to sha256 changes every reference they
have already published, so it needs an owner decision about versioning the manifest schema, not a
consolidation PR. Flagged here rather than silently unified.

## Layer 03 reinstated — the cancellation was wrong

Layer 03 was cancelled on the grounds that the runners' `digestRef` is `sha256:` while core's
was `fnv:`, so migrating them would rewrite every published digest reference. The premise was
checked and did not hold:

- **Nothing verifies these values.** `runner-github/src/manifest.ts` checks only that
  `fact.source.digest` is a non-empty string. The only assertions on the `fnv:` prefix anywhere
  in the repo were the ones added by layer 01 an hour earlier.
- **Nothing has been published.** No manifest has ever gone from this repo to a live provider.

So the cost of converging was zero, and the cost of not converging was two algorithms behind one
name. **Converged on SHA-256**, which is what the runners already did and what the threat model
requires: these bundles are fetched from a provider-controlled origin, and a 32-bit FNV walk
emitting 8 hex digits is brute-forceable in milliseconds — a typo detector, not integrity.
`stableDigest`'s own comment said "not a security primitive", which was accurate and was the bug.

Verified: 10 of 20 published documents changed, and the only differing fields are `digest` and
`documentRef`, with line counts unchanged — no structural drift. All five provider suites, all
three runner suites and core stayed green, which is itself the evidence that nothing consumed
the old values.

With the algorithms equal the runners could join: −72 lines across the three, and `sortKeys` is
now exported from core because `runner-github` needs the ordered *object*, not the string.

## Layer 04 — the stack was adding lines, so this subtracts them

Called out and correct: layers 00–03 were net **+215** across the stack, and test files alone
were **+234 with zero deletions**. A consolidation initiative that only adds is not one.

`describeConcern` (in `@hobo/contract-harness`) reads a `.cases.jsonl` beside the test, groups
rows by member, and emits one test per member. Setup and teardown are declared once as
`subject`/`teardown`. A case is a line of data, so adding one is a one-line diff instead of
another copy of arrange-act-assert.

It also does what a hand-written suite cannot: the subject's callable surface is read at runtime
and **a member with no cases fails the suite**, naming it. Falsified by adding an untested export
— `expected [ 'untestedHelper' ] to deeply equal []`.

| Suite | Before | After | Delta |
|---|---|---|---|
| `capability-manifest` | 166 | 56 (25 test + 31 cases) | −110 |
| `naming` | 119 | 33 (18 test + 15 cases) | −86 |
| harness | — | 158 | +158 |
| **layer total** | | | **−28** |

Core went from 155 to 166 tests while shrinking, and every further adopter is pure subtraction —
the harness cost is paid once.

Two harness bugs were found by using it rather than by reading it: `match` compared
`String(actual)`, which is `[object Object]` for any returned record; and ES module namespaces
expose every export as a getter, so constants were being demanded as "members needing cases".
Module namespaces now cover functions only — a constant is pinned by the cases that use it.

## Layer 05 — the sweep, and where it stops

Measured before converting anything: **900 of 3,711 `it` bodies in this repo are single-expect,
and only 13 files are wholly so** (561 lines, mostly trivial). A mechanical codemod would have
converted nothing worth having. The dominant shape is *several assertions about one call*, which
the harness could not express — so the harness was the blocker, not the tests.

Two additions, both reusing what the repo already had rather than inventing matching semantics:

- **`subset`** — assert part of a result. Built on `isRecursiveSubset`, which the pact matcher
  already depended on.
- **`throwsSubset`** — assert against the thrown error. Deliberately one key rather than
  `throwsCode` + `throwsName` + whatever comes next: this repo has two error idioms (some carry a
  `code`, others a `name` plus structured fields like `declaration`/`path`), and a subset covers
  both without the format growing a key per field. `throwsCode` was written first and withdrawn
  when `SdkDeclarationError` turned out to carry no `code`.

| Suite | Before | After |
|---|---|---|
| `capability-manifest` | 166 | 56 |
| `naming` | 119 | 33 |
| `plugin-manifest` | 102 | 41 |
| `sdk/resource` | 94 | 39 + cases (two concerns: the factory, and what it returns) |
| `sdk/dispatcher` | 91 | 64 + cases |
| `registry/ingest` | 96 | 51 + cases |

### Findings

- **Two harness defects, both found by using it rather than reading it.** A `throwsSubset` case
  whose call returned normally passed *silently* — the "expected a throw" guard only knew about
  `throws`. And the catch branch never handled `throwsSubset` at all, because the edit landed on
  the parse side only, so those cases re-threw and read as ordinary failures.
- **The harness had no tests.** For an assertion library that is the one gap that takes every
  suite built on it down quietly. It has 14 now, each about a way it could report green while
  checking nothing.
- **Adoption costs a `@hobo/contract-harness` devDependency per package**, and a lockfile entry.

### Where it stops — recorded, not forced

- `capability-matrix/validate` filters findings out of **one shared computed matrix**: analysis
  over a single value, not input/output per case.
- `provider-neon/api` takes fixture *files* and asserts on error internals.
- `dispatcher()`'s positive case refuses candidates it cannot see were authored by `runner.*`, so
  its input must be built rather than written down. The refusals are data; that one is not.

Each stays hand-written beside its cases. ~100 pure-ish candidates (~18k lines) remain; the shape
is proven and repeatable, and continuing is mechanical rather than novel.

### Boy-scout, and the reason two commits failed before this one

`test/designer-council-review-loop.test.ts` seeds a real git repository per test and spawns **32
git subprocesses**, against the global `testTimeout: 10_000`. Alone it runs in ~959ms; inside the
full pre-commit turbo matrix, competing with every package build for CPU and disk, it crosses ten
seconds and fails for want of a machine rather than a defect — the worst kind of red, because the
apparent fix is "re-run it". Sixty seconds on that `describe`, set there rather than raised
globally so a genuinely hung test elsewhere still fails fast. Falsified at 1ms: all eight time out.

The second failure was `docs:freshness` — code changed with no documentation change. Earlier
layers passed it incidentally because they touched this file; this section is the fix.


## Layer 05b — the assertions were not running

Two more defects, and the second one explains why the first survived a green suite.

**`subset` never asserted anything.** It was parsed, validated, and accepted by the case format;
the runner then ignored it. Seventeen cases across four converted suites were inert — they read
like assertions and checked nothing.

**A `throws` case that returned normally still passed.** The guard was
`expect.unreachable("expected a throw matching " + row.throws)` *inside* the same `try` as the
call, so it was caught by that block's own `catch`, which then matched the thrown message against
`row.throws` — and the message contains `row.throws` by construction. The guard defeated itself.

Both are the same root cause: the assertions lived inside the try/catch that wrapped the call, so
they could not be observed without running a whole suite, and the suite could not tell a failure
of the subject from a failure of an assertion. `assertCase(row, outcome)` is now split out over a
finished call — `{returned}` or `{threw}` — and is directly falsifiable. Fourteen new cases cover
it, one per way an assertion could fail to fire.

**And the reason I first reported the seventeen as "correct but unverified":** consuming packages
import `@hobo/contract-harness` through `dist`, not `src`. The harness's own tests import `src`
and went green immediately; every converted suite was still running the pre-fix build. Rebuilding
the package and re-running found a real wrong expectation — `sdk/resource` pinned
`hobo.resource-definition/v1` where the SDK emits `hobo.sdk/v1.resource-definition`. **A local
verification of a suite that imports a workspace package is not evidence until that package is
rebuilt.**

### Conversions (this layer)

| Suite | Before | After |
|---|---|---|
| `packs/pack-framework/manifest` | 318 | 51 + 27 cases |
| `trust/evaluate` | 347 | 122 + 27 cases |
| `capability-profiles/selection` | 405 | 138 + 32 cases |

Two of these got *stronger* in the move, because a data format makes the weak assertion obvious:

- `trust/evaluate` asserted reasons with `toContain`, which stays green when an unrelated rule also
  fires. The cases pin the whole sorted reason set. Verified two ways before landing: every code
  the old suite asserted is still present, and the four hand-rebuilt `parseTrustRequirement`
  literals turned out to equal `DEFAULT_TRUST_REQUIREMENT` exactly — thirty lines of duplicated
  policy that only had to name the field under test.
- `pack-framework/manifest` asserted canonical ordering as `order(a) === order(b)`, which holds
  just as well if the parser sorts nothing. The cases name the expected order.

### Where it stops — added this layer

- `bindles/bindle` builds its graph through a **callback DSL** (`bindle("shop", b => …)`). Making
  that JSON would mean inventing a serialised builder language, which is a bigger thing than the
  suite it replaces. Stays hand-written.

## Layer 06 — three more, and one that barely paid

| Suite | Before | After | Net |
|---|---|---|---|
| `claims/reducer` | 483 | 188 + 35 cases | −260 |
| `status-page/projection` | 447 | 99 + 31 cases | −317 |
| `yard-world/otel-mapper` | 360 | 239 + 24 cases | **−97** |

`claims/reducer` is the cleanest fit in the repo so far, and says something about
where this technique pays: a reducer's input **is** JSON — a command sequence
written down is the test. Two things collapsed into the subject and stopped being
copied: the five-command provisioning preamble every case restated, and the
`try { reduce(…) } catch { return caught }` block used four times to read one
error code. The `then` field is why one case can now pin both the state a
sequence reaches and the refusal that follows it.

`status-page/projection` is the same shape one level up — a fold over events —
and converts almost mechanically. Two assertions got stricter on the way: the
inverted-maintenance case now pins the whole row rather than
`maintenances["MTN-2"] === undefined`, which was also satisfied by a row that
never existed.

**`otel-mapper` is the honest counter-example.** It converted, it is greener
(21 cases against 13 tests, because multi-assertion tests split into one case
each), but it only removed 97 lines. The reason is worth recording: its bulk is
two OTLP payload *fixtures*, not repeated assertions, and a fixture has to live
somewhere. Moving it into the subject does not delete it. **When a suite is long
because of fixtures rather than because of repetition, this technique buys
coverage and uniformity, not size** — and the conversion should be justified on
those terms or skipped.

Running total across layers 04–06: **twelve concerns converted**, roughly 3,200
lines of test code down to 1,500 plus 260 case lines.

## Layer 07 — two more, and both got stronger

| Suite | Before | After | Cases |
|---|---|---|---|
| `contracts/gatekeeper` | 352 | 154 + 19 | 12 tests → 13 |
| `core/realization-result` | 335 | 98 + 40 | 11 tests → **34** |

Net −376 lines for +24 assertions, which is the shape worth wanting: the old
suites packed loops into single tests, and a loop is a case list that cannot be
named. `realization-result` had one test asserting nine heuristic boundaries and
another looping nine malformed inputs; those are eighteen lines of data now, each
individually named and individually red when it breaks.

### What the conversions exposed

- **`gatekeeper` gate labels are inconsistent.** `secretless-config`,
  `binding-delivery` and `can-migrate` reasons all report under
  `gate: "contracts"`, while `residency` gets its own gate. The old assertions
  only checked `code`, so nothing noticed. Recorded, not changed — it is
  existing behaviour and fixing it is a contract change, not a test change.
- **Redaction is now asserted rather than assumed.** `realization-result`'s
  fail-closed rule has two halves — the right rejection code, and the secret
  staying out of the message. The second half was a negated substring check
  buried in an `assert.throws` predicate. `parseRejection` returns `leaks`, so
  `"leaks": []` is the assertion and a regression names the secret it leaked.
- **The harness caught a dead member immediately.** A `parseRaw` helper written
  and then not used failed `covers every member` on the first run. That is the
  gap a hand-written suite cannot have, working as designed.

### Method note

Both conversions had wrong expectations on the first run — guessed gate names,
guessed emitted event types. Both were corrected against actual output rather
than by loosening the assertion, and both were falsified afterwards by flipping
one expected value and confirming a precise mismatch path.

## Layer 08 — widening, and a guard that was not guarding

`recipes/widening` 431 -> 221 + 30 cases; **12 tests -> 24 cases**.

Every downgrade in that module is a two-part rule — refused without an explicit
policy allowance, *and* still disclosed in the offer when allowed — and the old
suite asserted both halves inside one `it`. They are separate cases now, so a
refusal that stops refusing and a disclosure that goes quiet are two different
red lines instead of one.

**The meta-test was weaker than its own comment.** It carried the note "a new
kind added without a case here is the silent widening this module exists to
prevent" while asserting only that `WIDENING_KINDS` still held the same ten
strings. It never checked that any kind was *exercised*. `kindsWithoutCases`
now reads the case file and returns the kinds no case mentions, so the
assertion is `[]` and adding a kind without a case is red. Falsified by
corrupting one kind name in the cases file: the guard names it.

The declared-set assertion is kept alongside it, because the new guard catches
an *added* kind and the old one catches a *removed* one.

### Corrected against the original rather than guessed

Three cases were wrong on the first run because the setups are not uniform: the
credential lane rewrites what the **recipe delivers** while the request keeps
asking for the original, and the bootstrap lane uses a different recipe and
budget than the neighbouring ones. Both were read from the original and fixed,
not smoothed over by relaxing the assertion.

## Layer 09 — the fixture-heavy tier, and what it is worth

| Suite | Before | After | Tests → cases |
|---|---|---|---|
| `data-postgres/profile-matching` | 315 | 224 + 20 | 11 → 15 |
| `cloud/profile-matching` | 315 | 240 + 19 | 10 → 14 |

**Net −127 lines for +8 assertions**, which is a much weaker return than layers
07–08 (−556 for +47), and the reason is the one `otel-mapper` already recorded:
these suites are long because of **candidate fixtures**, not because of repeated
assertions. A `SelectionCandidate` is thirty fields, and moving it into the
subject does not delete it.

What the conversion still buys here is uniformity and named derivation. Both
suites built variant candidates by spreading a base and overriding two fields
inline, four separate times; a case now names the base and the override
(`{"from": "neon", "structuredCapabilities": {"ddl": false}}`), so the *reason*
a candidate differs is the thing you read.

**Judgement recorded for whoever continues:** convert the fixture-heavy tier for
consistency if the surrounding package is being converted anyway, but do not
expect subtraction from it. The remaining large candidates —
`pixel-village/yard-presenter` (800), `dispatcher` (651),
`connectivity/pure/traffic-routing` (633) — are grab-bag suites covering many
functions at once, so each is several concerns rather than one, and their return
is likely closer to this layer than to layer 07.

### One correction

`data-postgres`'s `wire.only-postgres` candidate is deliberately built from the
bare guarantees rather than the full base set — it speaks Postgres but has never
proven a migration tool. Deriving it from the base set instead made it pass a
gate it exists to fail. Caught on the first run, fixed with an explicit
`guaranteesOnly` flag rather than by adjusting the expectation.

## Layer 10 — a declared check that nothing could fail

`conformance/anonymous-conformance` is the fixture-heavy tier by the layer-09
measure: its bulk is twenty-one mutation closures, one per dishonesty, and
naming them in a map would not delete them. So this layer does **not** convert
it. It does the thing that was actually worth doing to it.

**`BINDING_CHECKS.roundTrip` had no dishonesty case.** Seventeen of the eighteen
declared checks across the four dimensions were exercised by a mutation that
proves they catch something; that one only ever saw the honest reference
adapter. A check nothing can fail is indistinguishable from a check that is not
there — which is precisely what this module exists to refuse in a *product*.

Two additions:

1. A dishonesty case for it — a produced binding whose id the parse boundary
   refuses. Falsified by making the mutation a no-op: the check goes back to
   `pass` and the case fails.
2. A guard that every declared check in all four namespaces has a case, so the
   gap cannot recur.

### The guard defeated itself first

Written with an explanatory comment that spelled the missing check in
`NAMESPACE.key` form. The guard reads its own source, so the **comment**
satisfied it on the case's behalf, and removing the case left it green.
Falsification caught that; the comment is reworded and now carries the warning.
This is the second time in this initiative that a fixture or comment has
satisfied the assertion meant to police it — the first was a temp directory
named `look-no-buzz-` matching a check for the word `buzz`.

The lesson worth keeping: **a guard that reads its own file has to be falsified,
not reasoned about.** Both failures looked correct on inspection.
