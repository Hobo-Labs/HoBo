# HOBO-6 CI Fabric OIDC E2E Contract

Independent proof for HOBO-6. It pins the PR CI and opt-in sandbox E2E
contract without implementing the out-of-scope cost-routed runner fabric or a
full multi-cloud E2E matrix.

> **Promotion (HOBO-586):** production guard + split workflows now live in
> [`packages/ci-guard/README.md`](../../../../packages/ci-guard/README.md).
> This folder remains historical HOBO-6 evidence; do not delete.

## Contract Surface

- `createHoboCiFabricContract()` returns the canonical PR gate, E2E gate,
  keyless OIDC role, teardown, quarantine, and wasm/OCI cache contract.
- `validateCiFabricContract()` fails closed when required PR build/typecheck/
  lint/unit/conformance checks, keyless OIDC, cost gates, teardown, sweeper,
  quarantine, or cache entries are missing.
- `simulateHelloBindleE2e()` models the `hello-bindle` sandbox path:
  OIDC token request, scoped token grant, `hobo up`, live URL assertion,
  teardown, and orphan sweep.
- `.github/workflows/hobo-ci.yml` makes the contract reviewable as a GitHub
  Actions workflow: the full local repo gate runs on every PR, while
  `hello-bindle` E2E is label/schedule/manual gated.

## Acceptance Mapping

| Acceptance | Executable proof |
|---|---|
| PR CI runs full unit+conformance suite and blocks on failure | `PR CI blocks on the full local gate including unit and conformance checks` |
| E2E authenticates to sandbox cloud with no stored secret, deploys `hello-bindle`, asserts live URL, tears down | `hello-bindle E2E uses keyless OIDC, asserts the live URL, and tears down` |
| Cost guard: E2E label/schedule gated, teardown asserted even on failure | `cost guard keeps E2E behind a label, schedule, or manual dispatch` and `teardown and orphan sweep run even when the live URL assertion fails` |

## Adversarial Mapping

| Adversarial case | Guard |
|---|---|
| OIDC trust over-broad | `OIDC trust fails closed when the sandbox role is over-broad` |
| Stored cloud secret sneaks into E2E | `stored cloud secrets are rejected; CI must use the OIDC token broker` |
| Failure leaks resources | `missing teardown or orphan sweeper fails the E2E contract` |
| Flaky E2E blocks merges | `flaky E2E runs have a non-blocking quarantine lane` |

## Boundary

This proof consumes the HOBO-4 componentize and HOBO-5 conformance harness
contracts. It does not implement real cloud deployment, provider IAM creation,
the Dispatcher runner-cost model, build-machine scheduling, or a multi-cloud E2E
matrix.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\ci-fabric-oidc-e2e-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Ci Fabric Oidc E2e Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
