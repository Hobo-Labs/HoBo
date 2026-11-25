# Vibe Docs Portal IA States

Independent M1 proof for HOBO-551.

This package records Docs Portal information architecture examples, audience
paths, search metadata, and stale-content states for launch-critical docs. The
proof covers getting started, API reference, architecture, operations,
troubleshooting, release notes, known limitations, security, and support without
building a portal UI, CMS, publishing pipeline, search service, analytics,
hosting, final copy, security intake, production UI, or unsupported launch
claims.

## Contract Boundaries

- In scope: content inventory records, audience path records, search metadata
  records, stale/unknown evidence states, proof-mode labels, support/release
  owner routes, accessibility notes, and scope-out guards.
- Consumed but not owned: HOBO-577 resource lifecycle quickstart examples,
  Docs Portal M0 scope, release notes, known limitations, troubleshooting,
  support channel, launch escalation, security verification, and accessibility
  launch baseline design records.
- Out of scope: docs portal UI, CMS, authoring/publishing pipelines, search
  indexing service, analytics, hosting, final customer-facing copy, security
  intake implementation, production UI, and proofless launch claims.

## Proof

```powershell
npm.cmd --prefix src\draft\exp-proofs\vibe-docs-portal-ia-states test
```

## Acceptance Map

| Acceptance | Evidence |
|---|---|
| IA covers getting started, API reference, architecture, operations, troubleshooting, release notes, known limitations, security, and support. | `contentInventory` is parsed in the required content-area order. |
| Fixtures name title, slug, audience, content area, source record, owner, freshness signal, proof mode, limitation state, and support/release owner. | `contentInventory` and `searchMetadata` carry every required field and reject unknown audience, freshness, proof-mode, and limitation labels. |
| Target package and proof paths are pinned. | `parseVibeDocsPortalIaStates` rejects package or proof path drift. |
| Happy path, blocked path, stale/unknown evidence path, support handoff, accessibility notes, and proof-mode labels are covered. | `scenarioPaths`, `accessibilityNotes`, and proof-mode validation cover each acceptance state. |
| Scope out remains hard. | `classifyDocsPortalIaRequest` rejects portal UI, CMS/publishing, search, analytics, final copy, security intake, support tooling, and proofless launch claims. |

## Architecture Evidence

- `architecture/` - protobuf data shapes and CUE constraints for the IA state
  record.
- `architecture/pacts/` - Pact-style package boundary fixture.
- `pnpm-lock.yaml` - workspace importer evidence for frozen-lockfile
  validation of this isolated proof package and adjacent current-main vibe
  proof packages preserved during rebases.
- `ADR.md` - parse-don't-validate and event/projection architecture note.
