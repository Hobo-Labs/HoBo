# Sandboxed Executors contract

Independent draft POC for HOBO-622 (S2-07). Models the Yard Executor as an
isolated sandbox seam for `@hobo/iac-pulumi` preview/apply and `@hobo/componentize`
build jobs: Firecracker when available with container fallback, dev-mode scoped
credential stubs, streaming `exec.*` events, and deny-by-default egress (NFR-007).

Promotes the sandbox and undeclared-egress scenarios from
`src/draft/epic-proofs/providers-iac-build-adapters/` and extends
`src/draft/technical-proofs/executor-skeleton-contract/` with real isolation
backend selection.

## Proven behavior

- `@hobo/iac-pulumi` preview/apply and `@hobo/componentize` build jobs dispatch
  through a sandboxed executor that emits `exec.Started`, `exec.Output`, and
  `exec.Succeeded` events accepted by the control-plane event schema.
- Sandbox backend selects Firecracker when available and falls back to container.
- Dev-mode credential stubs are short-lived, scoped, and non-ambient; tokens are
  always revoked after the run.
- Undeclared egress attempts are denied in the sandbox and end the run with
  `exec.Failed` (NFR-007).
- Adversarial tests cover container fallback inside `executor.run`, declared egress
  success, covert-channel audit behavior, and control-plane schema validation on
  failure paths.

## Scope boundaries

Contract POC only. No real Firecracker microVMs, container runtimes, Pulumi
Automation API calls, componentize builds, brokered SVID tokens, or production
`packages/cloud/src/executors/` code. Those belong to S2-05, S2-06, and later
identity slices.

## Check

```bash
pnpm exec turbo run test --filter ./src/draft/technical-proofs/sandboxed-executors-contract
```

## Architecture evidence

- `architecture/` — protobuf data shapes and CUE constraints.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
