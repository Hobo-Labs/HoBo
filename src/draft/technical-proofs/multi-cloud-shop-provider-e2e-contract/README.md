# HOBO-231 Multi-Cloud Shop Provider E2E Contract

Independent proof for HOBO-231. It models the GA gate for deploying the same
`examples/multi-cloud-shop` Bindle to AWS and Azure while keeping provider
runtime internals out of scope.

## Contract Surface

- `createPortableMultiCloudShopRun()` returns fixture evidence for the unchanged
  Bindle source digest, provider-specific `camp()`/`yard()` mappings, AWS and
  Azure deployment records, provider option resolution, `PortabilityReport`
  entries, negative rejection scenarios, and the cost-aware `camp` CI lane.
- `verifyMultiCloudShopGate()` fails closed when a target uses different Bindle
  bytes, topology or bindings diverge, `.with()` leaks to the wrong provider,
  `PortabilityReport` entries are not satisfied or inert across every target,
  camp checks are unrun, or negative `require`/single-provider scenarios do not
  reject with `deployment.PlanRejected`.
- `scripts/run-multi-cloud-shop-e2e-fixture.ts` is the CI entry point used by
  the gated E2E lane.

## Acceptance Mapping

| Acceptance | Executable proof |
|---|---|
| multi-cloud-shop deploys unchanged to AWS and Azure with identical topology/bindings | `multi-cloud-shop deploys the same Bindle to AWS and Azure with identical topology and bindings` |
| AWS-only `.with` option leaves Azure unaffected | `AWS-only .with options apply only to AWS and leave Azure unaffected` |
| `require` neither provider satisfies is rejected with a precise reason | `unsatisfied require rejects with precise deployment.PlanRejected evidence` |
| Bindle using a single-provider feature is refused on an unsupported provider | `single-provider features are refused on providers that cannot satisfy them` |
| job green in gated E2E lane | `gated camp-tagged E2E lane emits a green fixture report` plus `.github/workflows/hobo-ci.yml` `multi-cloud-shop-e2e` |

## Adversarial Mapping

| Adversarial case | Guard |
|---|---|
| byte-identical Bindle carries `.with()` leak to cloud N | `byte-identical Bindle carrying a .with leak to cloud N is refused` |
| byte-identical Bindle carries `.raw()` leak to cloud N | `raw driver leaks that are not satisfied by every target are refused` |
| binding resolves differently across providers | `binding divergence across providers fails the equivalence assertion` |
| provider camp checks are unrun | `provider with unrun camp checks cannot make a prod-ready claim` |

## Boundary

This POC does not build AWS or Azure providers, alter Planner/Matching
internals, or implement runtime-portability backends. It defines the reviewable
gate contract and CI lane shape that those provider implementations must satisfy.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\multi-cloud-shop-provider-e2e-contract test
node src\draft\technical-proofs\multi-cloud-shop-provider-e2e-contract\scripts\run-multi-cloud-shop-e2e-fixture.ts --phase deploy-and-assert --run-id local
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Multi Cloud Shop Provider E2e Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
