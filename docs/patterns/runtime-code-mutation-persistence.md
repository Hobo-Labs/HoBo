---
type: Pattern
title: "Persisting Runtime / AI-Generated Code Mutations Back to Source"
description: "When a program (or an AI agent) generates or modifies code at runtime, the change is ephemeral unless it is **persisted back into source** — and persisting raw text is unsafe: it l"
tags: [hobo, patterns]
---

# Persisting Runtime / AI-Generated Code Mutations Back to Source

> **Pattern** · safely writing runtime- or AI-generated code changes back into committed source (the "TypeScript patch lib" problem). Sources: [ts-morph](https://ts-morph.com/) · [recast](https://github.com/benjamn/recast) · [jscodeshift](https://github.com/facebook/jscodeshift) · [magic-string](https://github.com/Rich-Harris/magic-string) · [jsdiff](https://github.com/kpdecker/jsdiff). Excerpts quoted for analysis (fair use).

## What it is
When a program (or an AI agent) generates or modifies code at runtime, the change is ephemeral unless it is **persisted back into source** — and persisting raw text is unsafe: it loses formatting, clobbers hand-written code, breaks on the next regeneration, and arrives with no provenance or review. This pattern is the disciplined alternative: represent the edit at the **AST level** (or as a surgical, source-map-preserving string splice), apply it **idempotently** and **round-trippably**, mark **generated vs hand-written regions**, attach **provenance**, and route the result through **review/gating** before it lands as committed source. It is the engineering substrate beneath "the AI edited my code and committed a sane diff."

## Key elements / features
**AST-level edits + codegen (the TypeScript tooling landscape):**
- **ts-morph** — a navigation/manipulation wrapper over the TypeScript compiler API: load a project, traverse strongly-typed nodes, mutate (add/remove/rename declarations, members, imports), and emit back to disk. Best when the transform needs *semantic* TS understanding (types, symbols, references). Caveat: emission is reprinted, so whitespace/formatting fidelity should be verified and a formatter (Prettier) run after.
- **recast** — a **nondestructive** AST-to-AST transformer/pretty-printer built on **ast-types**: it shadow-copies the AST on parse, tracks an `.original` per node, and **reprints only changed nodes**, reusing original source for everything untouched (`print(parse(src)).code === src` when nothing changed). Best for preserving the author's exact formatting through a transform.
- **jscodeshift** — Facebook's codemod toolkit and runner; wraps recast, adds a jQuery-like collection API over the AST, and a CLI runner that applies a transform across many files with `--dry`/`--print` (dry-run) and parallelism. The de-facto choice for large, repeatable batch refactors.
- **magic-string** — operates on the **source string**, not the AST: `overwrite`/`append`/`prepend`/`remove` by character offset, generating a **source map** for the splice. Best for surgical, localized edits where you know the byte range and want minimal disturbance + maps — cheaper and more faithful than a full reparse for small mutations.
- (Adjacent: Babel/`@babel/*` for transform plugins; `ast-grep` for pattern-based structural search/replace.)

**Unified-diff / patch application:**
- **jsdiff (`diff`)** — create patches (`structuredPatch`, `createTwoFilesPatch`) and **`applyPatch(source, patch)`**, which *can fail* (returns `false`) when context no longer matches — a feature: it refuses to silently apply a stale patch.
- **diff-match-patch** (Google) — fuzzy patch application that tolerates a drifted source and reports per-hunk success, useful when the target may have changed since the diff was computed.
- **diff-apply** — strategies to relocate a hunk to the correct place even after the file shifted, beyond strict context matching.

**Cross-cutting properties:**
- **Idempotent / round-trippable transforms.** Re-running the transform on already-transformed source is a no-op (or stable); `apply` then `reverse` returns the original. This is what makes a generate→persist loop safe to run repeatedly.
- **Provenance.** Each generated change carries *what generated it* (model/version/input hash, the originating intent/trace) so the change is attributable and reproducible.
- **Generated vs hand-written regions.** Marking generated code — a dedicated `_generated/` directory, region markers/sentinels, or a manifest — lets tools regenerate the generated parts without touching hand edits, and lets review focus on the right surface.
- **Review gating.** Generated changes land via a reviewable diff (a PR/hook), not a silent in-place write; a CI `--check` regenerates and fails on drift.

## Relevance to HoBo
This pattern is the **mechanism HoBo needs to safely persist an AI-trained candidate back into committed source** — it sits directly under the `"use training"` + generated-stack loop. The canonical HoBo decision is **[ADR-0048](../design/adr/03-data-plane.md#adr-0048) (Persisted code-mutation mechanism)**, which adopts this pattern as the toolbox for `"use training"` promotion and pins the region-scoped, provenance-pinned, gated write-back rules.

**The HoBo problem it solves.** A `"use training"` method is an **AI-rewritable semantic function**: HoBo's `training-engine` rewrites its prompt/code against a rubric, producing candidates ([Plan 23](../design/generated-stack.md#plan-23), [ADR-0025](../design/adr/03-data-plane.md#adr-0025)). The events make the lifecycle explicit — `training.CandidateProposed` (rewritten prompt/code) → `training.CandidateEvaluated` → `training.Promoted`, alongside `impl.Generated` / `impl.Certified` / `impl.Promoted` ([Plan 11](../design/data-plane.md#plan-11)). Before [ADR-0048](../design/adr/03-data-plane.md#adr-0048), the open question was exactly this pattern: **once a candidate passes the gate, how does the rewritten code get back into the developer's repository safely?** Naive string replacement would clobber formatting, lose the boundary between the developer's baseline and the AI's edit, and break on the next training round. ADR-0048 now pins the answer — region-scoped AST edits, provenance, and gated write-back through the policy plane.

**How HoBo persists a promoted candidate ([ADR-0048](../design/adr/03-data-plane.md#adr-0048)):**
1. **AST-aware edit, not text splat.** A promoted candidate's body/prompt is written back via an AST-level transform (ts-morph for semantic edits, recast/magic-string to preserve the author's formatting), so the surrounding file — imports, the `@intent` docstring, the contract, the rubric ([Plan 23](../design/generated-stack.md#plan-23)) — survives untouched. The directive (`"use training"`) and its semantic grounding stay put; only the rewritable body changes.
2. **Generated-region markers.** The rewritable region is delimited so re-promotion edits *only* that region and never the hand-written intent/contract — the same generated-vs-hand-written discipline HoBo already commits to with the checked-in **`_generated/`** directory and **`hobo codegen --check`** drift gate ([ADR-0037](../design/adr/01-architecture-core.md#adr-0037)). Codegen there is a *deterministic pure function* of WIT/Zod/`.allow()`/graph; a promoted training candidate is the *non-deterministic* sibling and therefore needs even stronger region-isolation and provenance.
3. **Signed provenance.** The persisted change carries which model/optimizer produced it, the input/trajectory hash, the eval scores that cleared the gate, and the `training.Promoted` event id — published **signed with provenance** exactly as generation-pipeline artifacts are ([Plan 23](../design/generated-stack.md#plan-23)). The change is attributable and replayable: you can reconstruct which trajectories produced which candidate.
4. **Idempotent / round-trippable.** Because promotion is gated and re-runnable, the persist step must be idempotent — re-applying the same candidate is a no-op, and a superseded candidate is cleanly reversible (rollback re-applies the prior version through the gated saga, [Plan 5](../design/reliability-observability-cost.md#plan-05)).
5. **PR / gate, never a silent commit.** Persistence lands as a reviewable diff routed through the **policy plane** ([Plan 29](../design/contracts-policy-flags.md#plan-29)): `phase: promote` decisions with obligations ("prod promotion → require human approval," "→ require shadow evaluation"). The promotion gate is already **conformance(contract) green AND eval thresholds met AND policy allows** ([Plan 23](../design/generated-stack.md#plan-23)); this pattern adds the *write-back* as the final, reviewable, provenance-pinned step of that same gate — adding **no new trust path** ([ADR-0025](../design/adr/03-data-plane.md#adr-0025)).

**Why HoBo is well-positioned.** Event-sourcing ([Plan 11](../design/data-plane.md#plan-11)) gives provenance and replay for free; conformance + recorded-trace replay ([Plan 9](../design/generated-stack.md#plan-09)/[Plan 23](../design/generated-stack.md#plan-23)) gives the idempotence oracle (a persisted candidate must still reproduce recorded traces); and the existing `_generated/` + `codegen --check` discipline ([ADR-0037](../design/adr/01-architecture-core.md#adr-0037)) already models generated-vs-hand-written regions. The TS tooling above (ts-morph / recast / magic-string / jsdiff) is the concrete library layer HoBo would sit behind a `code-rewrite` capability to make `training.Promoted` produce a safe, reviewable source diff rather than an opaque runtime mutation — exactly as [ADR-0048](../design/adr/03-data-plane.md#adr-0048) specifies.

## Sources
- [ts-morph — TypeScript compiler-API wrapper](https://ts-morph.com/)
- [recast — nondestructive AST transformer (GitHub)](https://github.com/benjamn/recast)
- [jscodeshift — codemod toolkit (GitHub)](https://github.com/facebook/jscodeshift)
- [magic-string — surgical string edits + source maps (GitHub)](https://github.com/Rich-Harris/magic-string)
- [jsdiff (`diff`) — create/apply unified patches (GitHub)](https://github.com/kpdecker/jsdiff)
- [diff-match-patch (Google) — fuzzy patch application](https://github.com/google/diff-match-patch)
- HoBo internal cross-refs: [Plan 11](../design/data-plane.md#plan-11) · [Plan 23](../design/generated-stack.md#plan-23) · [Plan 29](../design/contracts-policy-flags.md#plan-29) · [ADR-0025](../design/adr/03-data-plane.md#adr-0025) · [ADR-0037](../design/adr/01-architecture-core.md#adr-0037) · [ADR-0048](../design/adr/03-data-plane.md#adr-0048)
