# Provider Capability Conformance Suites POC

Independent HOBO-102 proof for provider-capability suites.

## Scope

This POC defines the seed suite catalog for provider capability ports:

- `database`
- `objectStore`
- `compute`
- `queue`
- `cache`
- `dns`

The suite runner proves a provider may only claim a capability when a matching suite exists and the requested check tags pass. Checks are split into:

- `local`: offline checks suitable for `hobo dev` and local/container providers.
- `camp`: real-provider checks for IAM, mTLS, quota, and drift evidence.

## Proven Behaviors

- A reference local/container provider passes the local `database`, `objectStore`, and `compute` suites.
- Broken fixtures fail precise checks for leaked destroy state and refresh drift blindness.
- `hoboVerify()` reports `local` plus `camp` coverage and refuses prod-ready claims when `camp` checks are unrun.
- A local-only provider can pass local checks while failing camp checks.
- Claimed capabilities without matching suites are hard gate failures.
- Flaky refresh behavior is rejected instead of being certified intermittently.

## Boundary

This is the per-capability suite contract from HOBO-102. It intentionally does not implement the generic `@hobo/conformance` harness, signing, publishing, runtime-port suites, or concrete cloud adapters.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Provider Capability Conformance Suites.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
