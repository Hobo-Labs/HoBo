# @hobo/ci-guard

Production package for [HOBO-586](https://linear.app/quickdeploy-ai/issue/HOBO-586). Promotes
[HOBO-6](../../../../docs/design/proofs/hobo-6-ci-fabric/index.md) CI fabric contract from the
historical draft proof at `src/draft/technical-proofs/ci-fabric-oidc-e2e-contract/`.

## Surface

- `createHoboCiFabricContract()` / `parseCiFabricContract(JsonValue)` / `validateCiFabricContract(contract, workflows)`
- `loadWorkflowFiles()` reads committed `.github/workflows/*.yml`
- `runExampleFixture()` parameterized over `examples/*` with append-only `e2e.*` JSONL events
- CLIs: `bin/assert-ci-contract.ts`, `bin/run-example-fixture.ts`
- Labels: `hobo/e2e`, `hobo/e2e-quarantine`

## Signed local runs

`hobo-ci.yml` may skip a covered job when the route job verified a signed local run of it
(`scripts/ci/local-attest.mts`, "Signed local runs" in
[`packages/ci/RUNNER-QUEUE.md`](../ci/RUNNER-QUEUE.md)). The contract holds that to two rules: the
route job checks out `scripts/ci/verify-attestation.mts` (`workflow.pr-gate.attestation-unverified`),
and the pr-gate reads the route job's own result before it accepts a skipped job
(`workflow.pr-gate.attestation-route-result`).

## Verification

```bash
pnpm --filter @hobo/ci-guard test
node --import tsx packages/ci-guard/bin/assert-ci-contract.ts
node --import tsx packages/ci-guard/bin/run-example-fixture.ts \
  --fixture examples/hello-bindle --phase deploy-and-assert --run-id local-dev
```

Sandbox cloud remains **simulate mode** — not proof of real provider deployment.
