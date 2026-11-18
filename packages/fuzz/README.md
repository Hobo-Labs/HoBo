# @hobo/fuzz

OSS-Fuzz-style **property oracles** and **serialized-input harnesses** for HoBo
control-plane invariants. The package drives in-memory adapters and provider
simulators. It never calls Azure, AWS, GCP, or paid SaaS.

Wire shapes live in [`data-models/fuzz.proto`](./data-models/fuzz.proto)
(documentation-only; no `buf.yaml`) and the Bindle hash boundary is fixtured in
[`contracts/pacts/fuzz-bindles-canonical.pact.json`](./contracts/pacts/fuzz-bindles-canonical.pact.json).
The in-process API surface is described by
[`contracts/openapi/control-sim.v1.json`](./contracts/openapi/control-sim.v1.json).

## Lanes

| Script | What it is | Default `agent:check` |
|---|---|---|
| `pnpm --filter @hobo/fuzz test` | fast-check properties + harness/API smoke | yes, via Turbo when this package changes |
| `pnpm run test:property` | bounded fast-check command traces | yes, also when Bindle manifest code changes |
| `pnpm run test:fuzz` | Jazzer-shaped serialized-input smoke | yes, as part of the package `test` script |
| `pnpm run test:fuzz:nightly` | seeded model and parser campaigns plus isolated RESTler and fault injection | no |
| `pnpm --filter @hobo/fuzz run test:fuzz:api` | require Schemathesis against the loopback simulator and CLI | no |
| `pnpm --filter @hobo/fuzz run test:fuzz:docker` | require the isolated RESTler and fault-injection campaign | no |

Pass the seed and run count to replay a campaign with the same inputs:
`-- --seed 1742 --runs 5000`. The command prints the seed and number of
cases completed in each campaign.

The reference model rejects unknown capability verbs and sparse verb arrays during
creation and attenuation before changing its clock, state, or event history.

Trainable gold/silver: `fuzzTrainable(fn, seeds)` runs seed-holds,
determinism, fail-closed, pollution, and bound checks against a live
`"use training"` function. Outputs may be circular, bigint, `Date`, or
`NaN` — the harness serializes them instead of crashing. Corpus-only
`silverEvidenceFromCorpus` does not claim `seedHolds` (no live function
ran). `@hobo/evals` scores that as the silver suite; the evals sidecar
runs gold + silver on every `/run`.

Jazzer.js is the coverage-guided entry
[`src/jazzer-entry.ts`](./src/jazzer-entry.ts). PR smoke calls the same
functions with generated buffers. A long campaign is
`npx --package=@jazzer.js/core jazzer packages/fuzz/src/jazzer-entry.ts`
and is reserved for nightly.

Schemathesis runs all API checks against an owned loopback simulator. Install
Schemathesis 4.33.4 and pass `--api` to the nightly command. The command fails
if the executable is unavailable or its checks fail.

The Docker campaign requires a local Docker daemon and builds RESTler from a
pinned upstream revision. On its first run it downloads pinned container images
and builds the RESTler image. It starts the control simulator, Toxiproxy,
PostgreSQL, Redis, and a registry on a private internal network without
published ports. It exercises latency, bandwidth, timeouts, connection resets,
network cuts, retry idempotency, registry recovery, and RESTler API coverage.
The command fails if any required evidence is missing or reports a failure.
Containers and the network are removed when the campaign finishes or is
interrupted. Docker configuration and credentials are not passed to the
campaign containers.

Use `--no-docker` or set `HOBO_FUZZ_DOCKER=0` for the model and parser
campaigns alone. Pass `--docker` to require Docker even when that environment
variable is set. Default `agent:check` runs the bounded package tests without
starting Docker.

## Invariants

The `ControlModel` command set is create bindle, add capability, attenuate,
resolve provider, plan, apply, retry apply, interrupt apply, reconcile,
migrate provider, change tenant (refused), rotate secret reference, rollback,
destroy, and replay. Oracles include:

- `apply(apply(x)) == apply(x)`
- `replay(history(x)) == state(x)`
- `destroy(create(x))` leaves no owned resources
- retry of a failed apply never duplicates resources
- `attenuate(capability)` never increases authority
- equivalent manifests share a canonical hash
- tenant A operations never mutate tenant B
- rollback restores that tenant's snapshot slice (not the whole world, not just the clock)
- interrupt after destroy does not revive a resource
- apply after destroy recreates instead of leaving a destroyed hole
