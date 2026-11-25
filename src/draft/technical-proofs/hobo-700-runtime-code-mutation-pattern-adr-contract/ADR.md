# Runtime Code-Mutation Pattern ↔ ADR-0048 - Architecture Evidence

HOBO-700 is a docs-only intent-alignment remediation. It does not implement the
ADR-0048 persisted mutation runtime, codemod tooling, or promotion write-back.

## Schema Sources Of Truth

- **Protobuf** - `proto/runtime_code_mutation_pattern_adr.proto` defines the
  pattern-doc link gate record and link-state vocabulary.
- **CUE** - `cue/runtime_code_mutation_pattern_adr.cue` constrains the gate
  record with the required ADR-0048 link target and minimum retargeted links.
- **PACT** - `contracts/pacts/runtime-code-mutation-pattern-adr.pact.json`
  records the boundary between intent-alignment remediation and the pattern doc
  provider.

## Parse, Don't Validate

Pattern-doc inputs are parsed once into **derived domain types**:

- raw markdown becomes `ParsedRuntimeCodeMutationPattern` only after the
  ADR-0048 link, Relevance-section presence, and stale-link absence checks pass;
- a synthetic stale fragment makes the stale state unrepresentable past the parser.

After parsing, remediation consumers receive parsed gate results rather than
repeated substring checks at every call site.

## Event Architecture

Runtime promotion is deferred, but the vocabulary is named for traceability:

- **Command** - `LinkRuntimeCodeMutationPatternAdr` records the docs-only fix.
- **Event** - accepted commands emit `intent.PatternAdrLinked`; stale claims emit
  `intent.PatternAdrStale`.
- **Actor** - the Intent-Alignment Gap Remediation actor owns the acceptance stream.
- **Event store** - link and stale events append to the hygiene/traceability store.
- **Materialized view / projection** - the pattern index projection folds ADR link
  state for docs/patterns consumers.
- **Snapshot** - snapshots preserve the latest linked pattern digest for audits.
- **Read store** - design-suite readers consume the linked pattern state from the
  read store, not ad hoc grep notes.

This package keeps scope to documentation alignment. AST codemods, training
promotion, and persisted mutation tooling remain future ADR-0048 implementation work.
