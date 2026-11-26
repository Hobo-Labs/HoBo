# HOBO-644 Portability Conformance Lane Proof

This proof backs [NFR-001](../../../archive/requirements/requirements.md) portability,
[NFR-020](../../../archive/requirements/requirements.md) agnostic-core layering, and
[ADR-0024](../../adr/07-portability-extensibility.md#adr-0024) gated portability.

The executable POC in
[`src/draft/technical-proofs/s4-08-portability-conformance-lane-contract`](../../../../src/draft/technical-proofs/s4-08-portability-conformance-lane-contract)
proves the `@hobo/conformance` NFR-001 lane and NFR-020 boundary extension:

| Requirement | Test evidence |
|---|---|
| `bindle()` + `src/` byte-identical across AWS/Azure targets | `NFR-001 lane passes when the same unedited Bindle deploys to AWS and Azure with identical topology` |
| Only `camp()`/`yard()` mapping varies | `only camp()/yard() mapping varies across cloud targets` |
| Identical resolved topology on both clouds | same NFR-001 pass test + `binding divergence across providers fails topology equivalence` |
| Provider option isolation | `AWS-only .with options apply only to AWS and leave Azure unaffected` |
| Seeded provider-leak fails lane | `adversarial: seeded provider-leak mutation fails the NFR-001 lane` |
| Edited-Bindle mutation fails lane | `adversarial: edited-Bindle mutation fails the unedited byte-identical assertion` |
| NFR-020 core/sdk cannot import provider | `NFR-020 boundary lint fails seeded core/sdk to provider import` |

Scope kept out: production promotion into `packages/conformance/`, live AWS/Azure CI
credentials, Matching/Resource Packs (HOBO-641), and cross-cloud Junction mTLS (HOBO-642).

Maintenance: architecture-guard parse/event vocabulary lives in the draft package `ADR.md`.
