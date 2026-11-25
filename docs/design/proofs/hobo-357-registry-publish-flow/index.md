# HOBO-357 Registry Publish Flow Proof

This executable proof pins the M1 publish lifecycle from
[ADR-0062](../../adr/07-portability-extensibility.md#adr-0062),
[Plan 9](../../generated-stack.md#plan-09), and
[Plan 23](../../generated-stack.md#plan-23): signed artifact plus conformance plus provenance
becomes a certified registry listing; uncertified artifacts remain unlisted.

## Acceptance Mapping

| Acceptance | Executable proof |
|---|---|
| Passing fixture artifact yields a `Certified` listing discoverable in the catalog read model. | `publish with a passing conformance report certifies and indexes a listing`, including the OCI store ref assertion |
| Publishing without a passing report leaves it unlisted with a precise reason. | `publish without a passing conformance report remains published but unlisted` |
| Listing carries signature, provenance reference, and publisher identity. | `publish with a passing conformance report certifies and indexes a listing` |
| `listing.Published` and `listing.Certified` are emitted in order. | `publish with a passing conformance report certifies and indexes a listing` |

## Adversarial Mapping

| Adversarial case | Guard |
|---|---|
| Stable interface claim backed only by an experimental pass. | `stable interface claims refuse an experimental-only conformance pass` |
| Signature/provenance builder identity does not match declared publisher trust domain. | `publisher identity must match the signed provenance builder identity` |
| Re-publish of an already-certified `name@version`. | `republishing an already-certified name and version appends immutable history` |

## Boundary

The proof lives in
[`src/draft/technical-proofs/registry-publish-flow-contract`](../../../../src/draft/technical-proofs/registry-publish-flow-contract/README.md).
It consumes HOBO-7 signing/install verification facts and proves handoff to an OCI-shaped store
boundary. It does not implement a production OCI adapter, install, discovery ranking, yanking,
trust-tier computation, or real conformance execution.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\registry-publish-flow-contract test
```
