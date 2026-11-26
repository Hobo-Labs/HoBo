# SDK Object Graph Manifest IR Shapes - Architecture Evidence

## Status

Accepted for HOBO-568 proof scope.

## Context

HOBO-568 needs SDK-facing examples that make HoBo's Bindle/Camp/Yard/Junction
object graph concrete before downstream CLI, API, MCP, docs, and launch-demo
slices render it. The repository is still design-first, so this package must
prove the interface shape without publishing `@hobo/bindles`, generating
production bindings, or calling live providers.

## Decision

Record the SDK object graph shape as an experience proof under
`src/draft/exp-proofs/api/sdk-object-graph-manifest-ir-shapes`.

The proof keeps examples interface-only:

- examples import from `@hobo/bindles` as the intended public package name;
- generated binding references are stable `hobo:sdk/*` names;
- manifest output is `hobo.manifest/v1`;
- DeploymentPlan, migration plan, inspect, and log reader examples use
  deterministic fixture ids;
- `.raw()` provider edges and authoritative-external resources are surfaced as
  debt; and
- scope creep is rejected by the parser before downstream consumers receive a
  parsed record.

## Parse Boundary

This package applies parse, don't validate. Untrusted proof data enters through
`parseSdkObjectGraphProof`. The parser emits a branded parsed record only after
the issue, target paths, design anchors, audiences, example kinds,
proof-mode labels, debt markers, and scope boundaries match the HOBO-568
contract. Core consumers accept the parsed record rather than raw DTO values.

The parsed record is the package's derived domain type: downstream CLI, API,
MCP, docs, and launch-demo slices consume `ParsedSdkObjectGraphProof` instead of
re-checking raw proof fields.

## Event Architecture Vocabulary

The later product event flow is not implemented here. This proof names the
future boundary:

- command: record or update SDK object graph example evidence;
- event: `dx.SdkObjectGraphShapeRecorded`;
- actor: the DX proof aggregate for SDK-shape evidence;
- event store: accepted events append to the HoBo event log;
- projection: a proof-registry read model exposes fixture ids and proof modes;
- snapshot: the parsed proof record is the current projection snapshot;
- read store: downstream CLI/API/MCP/docs slices query the projection, not raw
  proof files.

## Alternatives Rejected

- Build the production SDK now: rejected because HOBO-568 is a shape proof, not
  a package-publishing task.
- Copy unmerged DX scenario matrix files: rejected because this proof must stand
  alone on its branch and reconcile cleanly when HOBO-567 merges.
- Prose-only examples: rejected because downstream slices need deterministic
  fixture ids, type-checkable interface declarations, and scope-creep guards.

## Consequences

Downstream work can cite a stable package and proof note for SDK object graph
examples while reviewers can see that live provider execution, production
bindings, real credentials, and new SDK semantics remain outside this slice.
