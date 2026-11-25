# S4-08 Portability Conformance Lane Contract POC

Independent POC for HOBO-644: the `@hobo/conformance` NFR-001 portability lane and the
NFR-020 agnostic-core boundary lint, centered on the `examples/multi-cloud-shop` fixture.

## Requirements Source

- `docs/archive/requirements/requirements.md` **NFR-001**: unedited Bindle deploys to multiple
  providers; `bindle()` definition + app `src/` byte-identical across targets; only
  `camp()`/`yard()` mapping varies.
- `docs/archive/requirements/requirements.md` **NFR-020**: agnostic core never imports a
  provider/adapter package; enforced at build time.
- `docs/design/adr/07-portability-extensibility.md#adr-0024`: gated portability over declared
  non-portable surface; `multi-cloud-shop` E2E proves identical topology + bindings.
- `src/draft/epic-proofs/portability-registry-distribution/`: portability registry evidence
  promoted by this lane.
- `src/draft/technical-proofs/multi-cloud-shop-provider-e2e-contract/`: prior camp-tagged E2E
  gate this lane formalizes for `@hobo/conformance`.

## Contract Surface

- `createPortableConformanceEvidence()`: builds NFR-001 lane evidence from the
  `fixtures/multi-cloud-shop` portable surface (`bindle.ts` + `src/`).
- `runNfr001PortabilityLane(evidence)`: asserts byte-identical bindle/src, mapping-only
  variance, identical resolved topology on AWS + Azure, and satisfied/inert non-portable surface.
- `validateNfr020BoundaryImports(edges)`: extends the production boundary lint so `packages/core`
  and SDK packages (`bindles`, `runtime`, `wit`) cannot import provider/adapter packages.
- `seedProviderLeakMutation` / `seedEditedBindleMutation`: adversarial fixtures that must fail the lane.

## What This Proves

- The `multi-cloud-shop` fixture records `bindle.ts` + `src/` as the portable byte surface.
- AWS and Azure targets share one bindle digest while camp/yard mapping digests differ.
- Resolved resource topology and bindings are identical across both clouds.
- AWS-only `.with()` options stay scoped to AWS; a seeded leak to Azure fails `provider-option.leaked`.
- An edited Bindle mutation fails `bindle.not-byte-identical` even when topology is unchanged.
- NFR-020 rejects a seeded `packages/bindles -> packages/providers/provider-aws` import.

## Scope Boundary

This does not promote the lane into production `packages/conformance/`, wire live AWS/Azure CI
credentials, or implement Matching/Resource Packs from HOBO-641. It is the executable contract
slice those packages consume after S4-05/S4-06 land.

## Verification

```bash
pnpm --prefix src/draft/technical-proofs/s4-08-portability-conformance-lane-contract test
```

## Architecture Evidence

- `architecture/` — protobuf data shapes and CUE constraints.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
