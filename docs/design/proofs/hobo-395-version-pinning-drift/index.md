# HOBO-395 Version Pinning Drift Guard Proof

This executable proof pins the M3 adversarial version-pinning guard from
[ADR-0024](../../adr/07-portability-extensibility.md#adr-0024),
[ADR-0075](../../adr/07-portability-extensibility.md#adr-0075), and
[ADR-0095](../../adr/07-portability-extensibility.md#adr-0095). It composes the
HOBO-336 version policy and HOBO-370 resolver while keeping resolver internals,
upcaster codemods, yank lifecycle behavior, and host-version pinning out of
scope.

## Acceptance Mapping

| Acceptance | Executable proof |
|---|---|
| A simulated breaking preview bump leaves a deployed Bindle's pin unchanged. | `ordinary redeploy preserves a deployed preview pin despite a higher preview release` asserts ordinary redeploy preserves the `wasi.websocket@0.2.0` pin while `0.2.1@preview` is available. |
| A floating range does not drift a pinned consumer past a breaking boundary. | `floating ranges cannot drift a pinned consumer across a breaking preview boundary` asserts `^0.2.0` plus lockfile/manifest pins still redeploys the old digest and reports explicit upgrade remediation. |
| At window expiry the old pin is unservable and redeploy is blocked while the running instance is not force-rewritten. | `expired deprecation window blocks redeploy without force-rewriting the running pin` returns `redeploy-blocked-unservable-pin`, preserves `runningPins`, and sets `forcedRewrite: false`. |
| Adopting the bump produces a new Bindle version. | `adopting the preview bump requires an upcaster and publishes a new Bindle version` rejects same-version adoption, rejects missing upcasters, rejects missing conformance evidence, then accepts `shop@1.1.0` with a passing conformance report. |

## Adversarial Mapping

| Adversarial case | Guard |
|---|---|
| Higher preview release cannot retroactively change a deployed Bindle. | Ordinary `plan` mode calls the resolver with manifest pins and asserts the old digest remains selected. |
| `0.x` preview bump treats every bump as breaking. | Adoption without an explicit `0.2.0 -> 0.2.1` upcaster returns `upcaster-required`. |
| Advisory-default websocket gets a gated migration path, not a surprise break or immortal pin. | Expired deprecation blocks redeploy with remediation, while explicit adoption requires a new Bindle version plus re-conformance. |

## Boundary

The proof lives in
[`src/draft/technical-proofs/version-pinning-drift-guard-contract`](../../../../src/draft/technical-proofs/version-pinning-drift-guard-contract/README.md).
It intentionally delegates version compatibility and distributed resolution to
the existing HOBO-336 and HOBO-370 packages.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\version-pinning-drift-guard-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
node scripts\validate-sdk-contracts.ts
node scripts\validate-deployment-set-delta.ts
git diff origin/main...HEAD --check
```
