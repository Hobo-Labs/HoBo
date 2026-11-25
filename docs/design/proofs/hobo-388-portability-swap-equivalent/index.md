# HOBO-388 Portability Swap-For-Equivalent Proof

This proof ties ADR-0024's portability conformance guarantee to ADR-0062's
never-gate-portability registry lifecycle and ADR-0073's swappable-port rule.
It stays at the distribution boundary: swapping a pinned listing changes the
dependency artifact, not the app source.

## Acceptance Mapping

| Requirement | Executable proof |
|---|---|
| Two listings implementing the same `interface@version` and passing the same conformance suite can be swapped without app-code change or tier check. | `swaps a pinned dependency to a conformance-equivalent listing without app code changes or tier checks` |
| Swap refusal is based on conformance failure, not trust or commercial status. | `refuses swap candidates that fail the same conformance suite` |
| No equivalent listing routes to generation. | `routes to generation when no listed equivalent exists` |
| Import/export of any listing remains available. | `import and export stay available for every listing regardless of trust or commercial tier` |

## Adversarial Mapping

| Adversarial case | Guard |
|---|---|
| Higher-trust listing tries to block lower-trust equivalent. | `a higher-trust source cannot block a lower-trust conformance-equivalent candidate` |
| Candidate fails conformance. | `refuses swap candidates that fail the same conformance suite` |
| Tier or commercial status blocks import/export. | `import and export stay available for every listing regardless of trust or commercial tier` |

## Boundary

Executable proof:
[`src/draft/technical-proofs/portability-swap-equivalent-contract`](../../../../src/draft/technical-proofs/portability-swap-equivalent-contract/README.md).

It composes with the existing discovery, install verification, publish, and
version-resolution proofs, but does not reimplement those systems.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\portability-swap-equivalent-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
git diff origin/main...HEAD --check
```
