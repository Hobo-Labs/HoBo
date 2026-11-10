---
type: Reference
title: "Technical standards"
description: "Repository technical standards: TypeScript-first implementation, Protobuf, CUE, parse-don't-validate, and PACT contract requirements enforced by the standards gate."
tags: [hobo, design]
---

# Technical standards

HoBo favors compile-time feedback over runtime error discovery. New production-facing code, executable contracts, proof fixtures, and integration boundaries must follow these standards unless an ADR records a narrower exception.

## Language and type feedback

- Use the latest stable TypeScript toolchain for HoBo-authored JavaScript-family code. As of 2026-06-29, the package registry and the TypeScript project identify TypeScript 6.0.3 / 6.0 as the stable latest line; keep the repo on the current stable line rather than adding new vanilla JavaScript modules.
- Do not add `.js`, `.jsx`, `.mjs`, or `.cjs` implementation files when a TypeScript-family source can provide static feedback. Use `.ts` by default, `.tsx` for React/JSX, `.mts` for ESM scripts that would otherwise be `.mjs`, and `.cts` only for explicit CommonJS requirements. The repo should remain free of tracked JavaScript-family implementation files unless an ADR records a narrow exception.
- Prefer generated, checked-in type views over hand-maintained structural duplicates: WIT remains the portable component interface, TypeScript is the authoring/reference language, Protobuf is the data-contract wire shape, and CUE carries invariants that TypeScript alone cannot prove.
- Compiler/typecheck failures should be treated as design feedback. A change that relies on a runtime exception for shape, range, state-machine, or boundary mismatch is incomplete unless the mismatch is inherently runtime-only and documented.

## Data contracts and derived object definitions

- Model data contracts in Protobuf at integration and persistence boundaries. Protobuf descriptors are the canonical interchange artifact for event bodies, service messages, provider-adapter payloads, and external API contracts; other views are generated from the same source family.
- Keep WIT, Protobuf, TypeScript, Zod/runtime guards, and documentation in sync through code generation or explicit contract fixtures. Handwritten duplicate schema definitions are allowed only as temporary migration shims with a removal note.
- Use CUE for invariants, refinements, and dependent constraints: ranges, formats, cross-field relationships, state-transition preconditions, provider capability predicates, environment-specific obligations, and compatibility rules.
- Apply "Parse, don't validate": unknown/untrusted inputs cross one parser boundary that produces a refined domain object. Downstream code consumes the parsed/refined type, not raw DTOs plus repeated boolean validation.
- Represent post-parse states as derivative object definitions. Example: `RawDeploymentRequest` parses to `DeployableBindle` only after CUE constraints, Protobuf shape, policy obligations, and dependency constraints succeed; functions that deploy accept `DeployableBindle`, not `RawDeploymentRequest`.
- **Generated types are the only record types.** A package with a `data-models/` folder opts into codegen by adding `data-models/buf.yaml`, runs `pnpm run codegen`, and imports its record types from the checked-in `src/_generated/**_pb.ts` (protoc-gen-es; parse with `fromJson(Schema, …)`, construct with `create(Schema, …)`). Hand-declaring a TypeScript `interface`/`type` that duplicates a proto message is a violation — derived types must be brands or narrowings **of** the generated types (branded ids, invariant-asserting parse functions returning the frozen generated message). Reference consumers: `examples/hello-bindle/src/api.ts` and `packages/core/src/ports/training-engine.ts`. Enum/state vocabularies belong in the proto (`enum`), not hand-written string arrays. A `data-models/` folder **without** `buf.yaml` is documentation-only: no code is generated from it and the codegen pipeline (production `packages/schema-tools` and its frozen s0-04 proof alike) skips it entirely — but keep message names unique within a shared proto package anyway, so opting in later doesn't surface declared-multiple-times collisions.
  - **The one legitimate coexistence — a domain view over a wire type.** Some records are deliberately richer on the app-facing side than any protobuf can express: a generic payload (`EventEnvelope<T>`), branded/derived ids (`RunId = string & brand`), or a string-union enum with nicer ergonomics than a numeric proto `enum`. There the hand-written type is the *parsed* side of parse-don't-validate and the generated `*_pb.ts` is its *wire* form (used at the persistence/transport boundary). This coexistence is by design, not debt — mark the declaration `// domain-view: <why>`. It is NOT a licence to re-shape a plain wire record by hand; use it only when the domain type is genuinely richer than the wire. The temporary-debt escape hatch (a hand record awaiting real migration) is `// parallel-type-allowed: <why>`; `pnpm run architecture:guard` accepts both markers and rejects an unmarked parallel.
- **Minimal public surface — no exported magic strings.** Do not export string-literal constants for schema ids, versions, type names, or enum vocabularies: schema identity is the generated message's fully-qualified type name and enums come from the generated `enum`. A constant may be exported only when the constant itself *is* the contract (a WIT port id, a pinned contract version) and its declaration line carries a `// public-contract: <why>` marker. Internal thresholds, prefixes, and defaults stay module-private.

## Integration boundaries and contract testing

- Every integration boundary needs a consumer-driven contract: SDK ↔ runtime, runtime ↔ provider adapter, control plane ↔ data plane, CLI ↔ daemon/API, event producer ↔ projection consumer, generated plugin ↔ host, and HoBo ↔ external service.
- Use PACT-style contract testing for those boundaries. HoBo's Contract IR can import/export PACT, OpenAPI, AsyncAPI, and Protobuf artifacts, but consumer/provider compatibility must be exercised before deploy and recorded as proof material.
- Prefer contract, conformance, typecheck, and CUE evaluation gates before runtime integration tests. Runtime tests remain necessary for behavior, determinism, and provider realism, but they should not be the first place schema or invariant drift appears.
- Property-based and coverage-guided fuzzing live in `@hobo/fuzz` ([fuzzing.md](./fuzzing.md)). **fast-check** is the primary framework for lifecycle/authority/canonicalization oracles over in-memory adapters. **Jazzer.js** is reserved for untrusted serialized input. **Schemathesis** may run against an ephemeral local OpenAPI surface in PRs (skip if missing). **RESTler**, **Toxiproxy**, and **Testcontainers** are nightly and docker-gated. Never point these tools at live Azure, AWS, GCP, or paid SaaS. Default `agent:check` must stay fast: bounded `numRuns`, no long Jazzer campaigns, no Docker.

## Enforcement

The repo-level `pnpm run standards:check` gate runs locally, in the pre-commit hook, and in CI. It currently enforces the standards that can be checked without product-specific context:

- `package.json` and `pnpm-lock.yaml` must keep the TypeScript toolchain declared and locked.
- `AGENTS.md` and this document must retain the canonical Protobuf, CUE, parse-don't-validate, and PACT guidance.
- Implementation files under `src/`, `scripts/`, or `test/` may not use `.js`, `.mjs`, or `.cjs`; use `.ts` unless an ADR/proof note records why the file cannot be TypeScript. The standards gate also fails if any tracked `.js`, `.mjs`, or `.cjs` file remains in the repository.
- Changed files under `packages/*/src/` may not add exported string-literal constants without a `// public-contract: <why>` marker on or above the declaration (see "Minimal public surface" above). The repo-wide backlog is surfaced by the `no-exported-literal-const` ast-grep rule via `pnpm run search:structure`.
- `pnpm run architecture:guard` additionally fails a changed package that hand-declares a TS `interface`/`type` named after one of its own proto messages outside `src/_generated/` (`parallel-proto-type`); deliberate exceptions carry `// parallel-type-allowed: <why>` and are tracked in the GAPS.md implementation-gap register (IMPL-011).

Repository-wide data-model catalogs are forbidden. Each project/package that owns a CUE-constrained type must keep its own `data-models/` folder beside the protobuf contract or proof package that owns that type. Protobuf descriptor parity, CUE evaluation, PACT fixtures, and parse/refinement tests must be implemented beside the contract they protect, not through a central `contracts/data-models` bridge.

`pnpm run architecture:guard` now covers production implementation packages under `packages/*` and `examples/*` in addition to draft proof packages under `src/draft/<kind>/<slug>`. Production packages must keep protobuf and CUE records under a package-local `data-models/` folder (no `.proto`/`.cue` elsewhere in the package) and executable PACT consumer/provider evidence (`*.pact.json` with `consumer`, `provider`, and `interactions`) under a package-local `contracts/` folder, in addition to the five architecture evidence checks that already apply to every changed implementation package.

Schema codegen and drift gates:

- `pnpm run codegen` — regenerate checked-in `src/_generated/` TypeScript views from protobuf sources via `packages/schema-tools` (promoted from the s0-04 POC); coverage is opt-in per package via `data-models/buf.yaml`, including nested category packages (`packages/{providers,runtimes,iac,build}/*`).
- `pnpm run codegen:check` — regenerate to a temp tree, byte-compare, exit non-zero on drift; never mutates the working tree.
- `pnpm run test:schema` — includes SDK/deployment validators plus `codegen:check` and the CUE vet lane. It builds `@hobo/core` and `@hobo/data` (Turbo) before the `@hobo/bindles` manifest lane, whose tests import their `dist` entries; a fresh checkout has no `dist` yet, which is what merge-group runs on a clean trunk runner hit.
- `pnpm run generated:guard` — pre-commit guard blocking hand-edits under `generated/`, `_generated/`, or `src/gen/` unless matching `.proto`/`.cue`/generator sources are staged.

## Agent checklist

Before committing a technical change, agents must verify:

1. New JavaScript-family code is TypeScript-first and typechecked.
2. Boundary payloads have Protobuf contracts or an explicit documented reason they do not.
3. Invariants/dependent constraints live in CUE, not scattered runtime checks.
4. Parsed/refined domain objects are passed inward instead of raw input DTOs.
5. Record types are imported from `src/_generated/**_pb.ts`, never hand-declared in parallel with a proto message; new packages with data-models opt into `pnpm run codegen`.
6. No new exported string-literal constants without a `// public-contract:` justification; enums/schema ids come from generated code.
7. Integration boundaries have PACT-style consumer/provider coverage or a tracked proof gap.
8. Matching docs and proof/contract READMEs describe the contract source, generated views, and gates.

## Performance-oriented local gates

Local and pre-commit automation must prefer changed-file scopes over whole-repository sweeps. The default hook runs `pnpm run check:relevant:staged`, which maps staged paths to root gates, documentation gates, contract validators, and pnpm-filtered `src/draft/<kind>/<slug>` package tests. The package-test lane uses Turborepo when the local native binary starts promptly and falls back to pnpm workspace filters when it does not. Broad repository unit and contract sweeps are reserved for explicit final or all validation. Full-repository checks remain available for merge confidence, but agents and humans should use the relevant check runner while iterating.

TypeScript proof code should use the repository-pinned latest stable TypeScript version. For experiments that need the Go-native TypeScript toolchain, the repository also pins `@typescript/native-preview`; keep proof packages on the shared TypeScript pin instead of adding older per-package compiler versions.

Package-manager standard: use pnpm, not npm, Yarn, or Bun, for repository-wide dependency installs and scripted gates. pnpm's content-addressable store and workspace filtering are the default performance path; Turborepo provides task graph caching; when the local Turbo native runner cannot start, relevant-check gates must fall back to filtered pnpm package proofs rather than skipping package tests. Vite is reserved for browser app packages that need a dev server; Bun is reserved for explicit Bun-runtime experiments with parity proof.

Linting standard: pre-commit lint must be path-scoped and cache-friendly. Use `pnpm run lint:docs:staged` for local commits, `pnpm run lint:docs:changed -- --base=<ref>` for branch work, and reserve `pnpm run lint:docs` for full verification. Shared documentation catalogs may widen a changed-file lint to a full scan when their contents affect global references.
