# @hobo/redaction-test-harness

Test-only harness for code that reads hostile text: a CPU-time growth measure,
a growth sweep that builds inputs from a pattern's own classes and literals,
and a differential that holds a redactor to the one it replaced.
`@hobo/provider-redaction` and every package that redacts provider text take it
as a devDependency; no runtime code imports it.

It is a leaf of its own, not part of `@hobo/contract-harness`: nearly every
package's tests depend on that one, `@hobo/core` among them, so a change to it
plans their whole suites, where a change here plans only the suites that
redact. It has no runtime dependencies: what a sweep searches with, and what a
redactor keeps on purpose, are passed in.

| Export | What |
|---|---|
| `@hobo/redaction-test-harness/linear-time` | `measureGrowth`, `assertGrowsLinearly`, `repeatedTo` |
| `@hobo/redaction-test-harness/linear-sweep` | the growth sweep, `assertPatternSweepLinear`, `assertInputLinear` |
| `@hobo/redaction-test-harness/redaction-differential` | `assertRevealsNoMore`, `assertFindsNoLess` |

## Linear time

`linear-time` proves an operation linear without a wall-clock bound that a slow
or loaded machine fails. `measureGrowth(run, input)` calibrates until the
smallest ladder size takes about 100 ms of CPU (configurable `minMs`), then
measures lengths `L`, `2L`, and `4L` in interleaved rounds and keeps the
**minimum** CPU time at each length. A log–log slope near 1 and doubling ratios
near 2 distinguish linear work from quadratic (slope near 2, doubling near 4).
`assertGrowsLinearly` throws a `NonLinearGrowthError` when the slope, a doubling
step, or the overall ratio crosses `LINEAR_LOG_SLOPE_LIMIT`,
`LINEAR_DOUBLING_LIMIT`, or `LINEAR_GROWTH_LIMIT` (8), then runs `input(1 MB)`
once. `NEGATIVE_CONTROL` holds an expected-to-fail operation to small sizes and
short ladders. The only absolute bound
is `HANG_BACKSTOP_MS` (20 s) on a single call, an `OperationHangError`.

## The sweep

`linear-sweep` runs one pattern or function on inputs nobody has to think of:

- runs of each character of its alphabet and of the separator classes (`_`,
  whitespace, `.`, `-`, `%`, `+`, `:`, quotes, `*`, `=`, `/`, `@`, `,`, two
  control characters), and every ordered pair of them;
- its own words before each run, and runs between its literal fragments
  (`patternFragments`: every literal of three or more characters in its source,
  and `=` and `:`), ended by a fragment or by each terminator;
- each word and fragment over and over, alone and with each separator after it
  (`(?:xyz)+!` and `Bearer[^!]*!` start once a copy);
- periodic texts, one class and then a period of another (`PERIODS`: 4, 16 and
  64), screened at as many periods as a short one (`ab{63}[ab]*!` starts once a
  period, which no run or pair shows).

`patternSpec(pattern)` reads a pattern's alphabet from its own classes
(`patternAlphabet`: every literal and range end, negated classes too, the class
escapes, the other case under `i`), so a class that holds `ſ` and `K` puts runs
of them in the sweep without anyone listing them. Each input's call on 2 Ki
characters is screened against the fastest of 32 reference scans of as many
characters (`referenceFloor`, cached per process): under 32 times that, the
better of three calls, and growing less than 8 times when called on four times
the length (`screenGrowth`, the better of up to three calls each), it is linear.
Linear patterns cost up to about 23, quadratic ones 160 or more where the ratio
was set; how many reference scans a quadratic call costs is the machine's (a
search that starts once a period, `ab{7}[ab]*!`, reads 28 on one), which is why
the growth is screened too: it reads about 4 for linear work and 16 for
quadratic anywhere. The screen is in wall time, since a call that short
reads 0 on the CPU clock; load only ever slows a run, so it cannot lift the
fastest of many scans, and a slowed call only costs a growth measurement, in
CPU time (`judgeInput`), and offends only if it grows past the limit when
measured again with longer runs: a heavily loaded machine can lift one reading
past it, and quadratic work grows about 16 both times. `assertPatternSweepLinear(pattern, search)` sweeps a
pattern through a caller's own search, screened against that search with a
pattern that never matches; `assertInputLinear` screens one fixed input, for a
fast tier; `ownPatterns(patterns, shared)` and `profilePatterns` pick what a
caller adds.

## The differential

`redaction-differential` holds a redactor to the one it replaced.
`assertRevealsNoMore(old, now)` generates texts of credential shapes,
separators and control characters carrying random markers, and fails when the
new redactor shows half a marker the old one hid; `kept` names what the new one
keeps on purpose (`@hobo/provider-redaction`'s `KEPT_LOCATOR`). The texts carry
credentials at their real lengths with a marker inside, percent encodings,
non-ASCII (`ſ`, `K`), zero-width and direction characters, secret names used as
schemes, digests a value is glued to, private keys whose BEGIN line a JWT runs
through, and a lower-case END line inside a key. What the new redactor keeps is
found once per text, and only in a text with a `://` in it. `assertFindsNoLess(old,
now, pieces)` does the same for a detector.

The fast tier runs a differential at 5k texts and a detector differential at
20k: every leak review rounds 3 and 4 found failed within 400 texts on three
seeds, and every earlier round's state fails the fast tier's fixed inputs. The
deep tier runs 50k texts on each of `DEEP_SEEDS` (three seeds), and the
detectors at 150k, for a leak rarer than any a review found.

## Test tiers

A package that uses the harness keeps two tiers. `test` is the fast tier, run
on every change: unit cases, every leak and hostile input a review found as a
fixed input (screened, not swept), and a differential at 5k texts. `test:deep`
(`vitest.deep.config.ts`, a turbo task each such package declares in its own
`turbo.json`, `pnpm run test:deep` at the root) runs `*.deep.test.ts`: the
sweeps, the growth measurements and the full-size differentials. A package's
`vitest.config.ts` extends the repository's and leaves `*.deep.test.ts` out.

## Architecture

The package is pure functions over strings and timings: it has no commands and
emits no events, runs no actors, and keeps no event store, projections or
materialized views, snapshots, or read stores. Its one boundary is a function
call from a test, recorded in
`contracts/pacts/redaction-test-harness-boundary.pact.json` as an in-process
library that owns no service boundary.

Parse, don't validate: a sweep's inputs are derived types built from the
pattern itself (`patternSpec`), and a measurement is returned as a `Growth`
record that `grewLinearly` reads, never re-derived from a timing by its caller.

## Data models

`data-models/redaction_test_harness.proto` describes the harness's evidence as
data: a growth measurement and a sweep input's outcome.
`data-models/redaction_test_harness.cue` constrains each. The TypeScript types
hold functions, which a record cannot, so they are not generated from the
proto.

## Commands

```bash
pnpm exec turbo run build test --filter ./packages/redaction-test-harness
pnpm exec turbo run build test:deep --filter ./packages/redaction-test-harness
```
