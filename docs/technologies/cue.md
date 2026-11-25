---
type: Technology Reference
title: "CUE (cuelang)"
description: "CUE (\"Configure, Unify, Execute\") is an open-source **data-validation language and inference engine** with roots in logic programming. It is a **superset of JSON** (every valid JSO"
tags: [hobo, technologies]
---

# CUE (cuelang)

> Technology — typed configuration / data-validation language. Source: [cuelang.org](https://cuelang.org/) · [Introduction](https://cuelang.org/docs/introduction/) · [Language spec](https://cuelang.org/docs/reference/spec/) · [GitHub `cue-lang/cue`](https://github.com/cue-lang/cue). Excerpts quoted for analysis (fair use).

## What it is
CUE ("Configure, Unify, Execute") is an open-source **data-validation language and inference engine** with roots in logic programming. It is a **superset of JSON** (every valid JSON document is valid CUE) extended with types, constraints, comprehensions, and references. Its defining idea is that **types are values**: CUE makes no distinction between a concrete value, a type, and a constraint — they all live in a single **lattice** ordered from `_` (top, "any") down to `_|_` (bottom, "error/conflict"), where a type like `string` is simply a value that is *less specific* than `"hello"`. Configuration, schema, validation, templating, and code generation are therefore the same operation applied at different points on that lattice.

The core operation is **unification** (`&`): combining two values yields their greatest lower bound. Unification is **commutative, associative, and idempotent**, so the order in which configuration fragments are merged never changes the result — a property CUE leans on to kill the "configuration complexity curse" of inheritance/override ordering.

## Key features
- **Superset of JSON**, with a friendlier surface syntax (optional quotes/commas, comments, references) and additional types; also reads/writes YAML and works with Go, Protobuf, OpenAPI, and JSON Schema via `cue import`/`cue def`.
- **Types == values, on a lattice.** `{ a: 3 }` is simultaneously data, a schema, and a constraint that only `3` satisfies. `string`, `>=0 & <100`, `=~"^v\\d+$"` are all just values.
- **Unification (`&`)** and **disjunction (`|`)**: `&` merges constraints (order-independent), `|` expresses alternatives/enums; a marked default `*x | y` selects `x` when otherwise ambiguous.
- **Definitions (`#Name`)**: closed schemas (no undeclared fields permitted) used as reusable types; regular fields stay open for templating.
- **Constraints & validation**: bounds (`>=0`), regexes, optional fields (`field?:`), required (`field!:`), and pattern constraints (`[string]: T`) over open structs.
- **Comprehensions, conditionals, and `let`** for computed configuration without a separate templating layer.
- **Tooling** — the most load-bearing commands:
  - `cue vet` — validate concrete data against a schema/constraints (the validation gate).
  - `cue export` — evaluate and emit final concrete data (JSON/YAML/…); fails if anything is incomplete.
  - `cue eval` — evaluate and show the (possibly still-abstract) value, useful for debugging.
  - `cue def` — print/consolidate the schema; `cue import` ingests external schemas into CUE.
  - `cue fmt`, plus a scripting layer (`cue cmd`) for workflow/automation.
- **Hermetic & deterministic**: evaluation is a pure function of inputs — no clock, RNG, or I/O in the language core — so results are reproducible and machine-manipulable.
- **Ecosystem**: a central module **registry**, and well-known adopters (Kubernetes config tooling such as Timoni, and Istio, which uses CUE to generate and validate its APIs).

## Relevance to HoBo
CUE is a natural reference point for the parts of HoBo where **typed, validated, machine-authored configuration** meets **deterministic selection** — but it competes with HoBo's TS-first stance rather than slotting cleanly behind a port.

- **Resource Definitions & matching** ([`../design/25-resource-definitions-matching.md`](../design/platform-engineering.md#plan-25)). A Resource Definition is a typed rule with **matching criteria** selected by a **deterministic, pure-function** ranking ([`../design/adr/ADR-0033-deterministic-matching-and-planner-selection.md`](../design/adr/01-architecture-core.md#adr-0033)). CUE's lattice/specificity model is conceptually close to specificity-scored matching, and its hermetic evaluation matches HoBo's determinism requirement. CUE could express/validate definitions in a tool-agnostic form (YAML-parity authoring, [Plan 25](../design/platform-engineering.md#plan-25) lists YAML as a supported surface). The tension: HoBo's matching is a **specificity score + explicit `priority` + objective + stable tiebreak**, not raw unification — CUE's order-independent merge does *not* express "most specific wins," so CUE would validate definitions, not perform selection.
- **The wiring manifest IR** ([`../design/22-wiring-manifest.md`](../design/authoring-resources-wiring.md#plan-21)). The manifest is a typed intermediate representation of the graph. CUE excels at validating such an IR and at *cross-format* generation (Protobuf/OpenAPI/JSON Schema in, validated config out) — relevant to HoBo's import/export targets and to keeping the IR honest across encodings.
- **Capability Manifest schemas** ([`../design/06-ai-native-agent-auth.md`](../design/ai-native-agent-auth.md#plan-06)). Where agents and the Forge generate config, a CUE schema gives a single, machine-checkable contract that generated artifacts must `cue vet` against — a guardrail for AI-authored definitions.
- **Contrast with HoBo's TS-typed approach.** HoBo deliberately keeps authoring in **TypeScript** (typed, testable, IDE-native, no second language to learn) and treats other formats as import/export targets, not the source of truth — the same "own the model, speak others at the boundary" stance as the policy ([Plan 29](../design/contracts-policy-flags.md#plan-29)) and contract ([Plan 29](../design/contracts-policy-flags.md#plan-29)) ports. CUE's value to HoBo is therefore mostly **inspiration and an optional interchange/validation layer** (`cue vet` as a conformance check on emitted config; CUE schemas as a portable contract for platform-engineer-authored or Forge-generated definitions) rather than a core dependency. Where HoBo's TS types stop at compile time, CUE adds runtime/CI validation of *concrete deployed values* — a genuine gap CUE could fill behind a validation hook.

Net: **validates / informs** HoBo's typed-config and deterministic-matching choices; a candidate **optional validation/interchange layer**, not a replacement for the TS-typed model.

## Sources
- CUE homepage — https://cuelang.org/
- Introduction (types-as-values, lattice, unification) — https://cuelang.org/docs/introduction/
- Language specification — https://cuelang.org/docs/reference/spec/
- Unification (tour) — https://cuelang.org/docs/tour/basics/unification/
- Configuration use case — https://cuelang.org/docs/usecases/configuration/
- GitHub — https://github.com/cue-lang/cue
