# ADR-0153 — `@hobo/patterns` catalog and ontology-vector retrieval

**Status:** Accepted  
**Date:** 2026-08-12

## Context

HoBo had three template surfaces: `hobo new -t todo|api|agent|fullstack`,
`hobo-code scaffold` / `openui-astryx-bindle`, and `#1087` atoms inside
`@hobo/code`. None was a typed, versioned catalog. This package is the
single source of truth.

## Decision

1. Canonical artifacts are `pattern.json` + rendering files. SQLite and VS Code
   snippets are generated projections. Semantic catalog digest is verified at
   load; SQLite page bytes are not a cross-version identity.
2. Default vector is a generated ontology from `@hobo/bindles` `CATALOG` and
   `@hobo/capability-profiles` primitives/runtimes, plus a reviewed alias layer.
   Vectors are L2-normalized little-endian float32 BLOBs. Exact ID/alias/symbol,
   FTS5/BM25 when available, and ontology cosine are fused with RRF (`k = 60`).
   No sqlite-vec, Faiss, HNSW, or loadable extension.
3. Zero-LLM proof is owned by `hobo-code template` and `/template`. Ordinary
   chat is unchanged. Receipts record `llmCalls = 0`.
4. `hobo new` and `hobo-code scaffold` are adapters. CLI starter file maps live
   in this package (`renderCliStarterFiles` walks catalog `project/` trees).
   Exact `todo|api|agent|fullstack` queries select `starter.cli.*` via the
   compatibility channel. The OpenUI starter moved to
   `patterns/starter/code/openui-astryx-bindle/project/`. `hobo-code scaffold`
   copies that catalog tree only — no leftover `templates/<id>` project
   fallback.
5. Application writes only inside a caller-supplied isolation root. Promotion
   stays `@hobo/code`.
6. Atomic snippets live in `packages/patterns/atoms` and load through the
   catalog. `hobo-code template list|search|render` is the CLI. Chat emit
   (ADR-0152) reads the same trees.
7. Structural TypeScript application uses the pinned TypeScript compiler API
   (`typescript@^6`). **ts-morph was rejected:** it vendors its own TypeScript
   compiler and lags the repo's TypeScript 6.0.3 toolchain, which would create
   a second parser identity and a heavier production dependency. The applier
   locates `bindle(...)` via the AST, inserts at node positions (so unrelated
   comments survive), and re-parses the result. It never uses line-number
   insertion or regular-expression source editing.

## Model2Vec rejection

Evaluated as an optional `DenseEncoderPort` challenger. **Not adopted.**

| Gate | Result |
|---|---|
| No runtime network | Official weights live on Hugging Face. Would require install-time or committed download. |
| No install download | Fail. |
| Approved license + digest + reproducible pack | No committed artifact; cannot attest. |
| Cross-platform Node load without native compile | Official path is Python / Rust-WASM. Shipping WASM or ONNX would add size and a second encoder identity. |
| Quality vs exact + FTS + ontology on this catalog (tens of concepts) | No measured gain that justifies the packaging cost. Held-out ontology+FTS already meets expected metrics. |

Default remains `hobo-ontology-vector-v1`. The port exists so a future
offline-packaged encoder can be measured without changing call sites.

## Consequences

- One proto+CUE package, receipts, calibrated abstention.
- Atoms stay until a dedicated delete; adapters must not fork new bodies.
- Chat create/run/debug from ADR-0152 is unchanged.

## Amendment (2026-11-08: hobo-code leaves main)

`hobo-code` and `@hobo/code` are developed on the long-lived
`feature/hobo-code` branch and are not part of `main`. Decisions 3, 4, 5 and
6 above name `hobo-code template`, `hobo-code scaffold`, `hobo-code promote`
and the OpenUI starter; those describe that branch. On `main` the catalog is
reached through `hobo new` and the library API, the OpenUI starter is not in
the catalog, and apply receipts carry `promotionRef: "caller-promotes"`.
