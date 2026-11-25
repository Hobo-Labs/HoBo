# generateProvider Correctness Spike

This draft package is the HOBO-211 proof harness for `generateProvider`
correctness, convergence, determinism, and reproducible certification.

It composes the existing generation IO, bounded repair, no-egress validation,
provider conformance, and certification draft contracts. The reference run is a
database provider generated against `hobo:database/postgres@0.1.0`.

## What The Harness Proves

- A reference database-provider generation run can converge, pass local provider
  conformance, replay recorded traces, and emit a signed reference certification
  record.
- An oscillating repair loop exhausts the default two-attempt budget and emits
  `gen.NeedsHuman` without certifying the artifact.
- Pinned model, frozen prompt, seed, target WIT, suite, and material digests
  reproduce the same candidate artifact digest and certification payload digest.
- Reference-only, local-only, and thin conformance suites cannot satisfy the
  minimum provider coverage bar for a production-certifiable database provider.
- Contradictory cold-start material cannot override the authoritative WIT target
  or conformance suite selected by `gen.Requested`.

## Coverage Bar

The reference harness certifies only the local trace/conformance proof. It also
computes the production coverage result and expects that result to remain blocked
unless the run includes real Camp evidence. Fixture Camp checks are not accepted
as production proof.

The production database provider coverage bar requires these local and Camp
checks:

- `database.local.provision-connects`
- `database.local.honors-require-prefer`
- `database.local.refresh-reports-drift`
- `database.local.destroy-cleans-state`
- `database.camp.real-provider-drift`
- `database.camp.iam-mtls-quota-evidence`

Passing a subset is treated as a non-certifiable result even when the subset
itself reports `pass`.

## Run

```powershell
npm.cmd --prefix src\draft\technical-proofs\generateprovider-correctness-spike test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Generateprovider Correctness Spike.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
