# Resource lifecycle quickstart examples

This package proves `HOBO-577`: a canonical docs-ready quickstart fixture for
the resource lifecycle story across define, collect, plan, deploy, inspect,
manage, migrate, and recover.

It is a fixture contract. It does not publish production docs, add live
credentials, replace lifecycle paths with dashboard tours, or promise customer
outcomes.

## Contract shape

Each quickstart phase includes SDK, CLI, API, and MCP snippets. Every snippet
names:

- fixture id
- proof-mode label
- safe claim
- docs-ready text

The proof modes are:

- `reference-fixture`
- `simulated`
- `live`
- `scope-out`

Parse, don't validate: the TypeScript parser is the single runtime boundary for
this proof. Downstream docs, tutorial, workspace, plan/diff, and dashboard
packages should consume `parseResourceLifecycleQuickstartExamples` and work
from the branded parsed derived type instead of raw fixture data.

## Contract anchors

- Protobuf: `architecture/resource_lifecycle_quickstart_examples.proto`
- CUE constraints: `architecture/resource_lifecycle_quickstart_examples.cue`
- Pact-style fixture: `architecture/pacts/resource_lifecycle_quickstart_examples.pact.json`
- Executable acceptance: `test/resource-lifecycle-quickstart-examples.test.ts`

## Handoff consumers

The fixture names handoff notes for Docs Portal, Tutorials, Troubleshooting,
Launch Site, Workspace UX, Plan/Diff, and Dashboard consumers. Those consumers
may reuse the fixture ids and safe claims. They must not turn this proof into
production docs publication, live credential setup, customer promises, or
enterprise dashboard feature tours.

## Verification

```bash
pnpm run test:file src/draft/exp-proofs/dx/resource-lifecycle-quickstart-examples/test/resource-lifecycle-quickstart-examples.test.ts
```

Branch-level evidence also runs the repo architecture, standards, docs,
traceability, and staged agent checks.
