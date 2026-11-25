# App Developer Journey Contract POC

HOBO-198 proof for the app-developer path:
`hobo new snapshop -t api` -> `hobo dev` -> `hobo inspect run --last` -> `hobo up`.

## What This Proves

- The scripted journey scaffolds the app, edits `app.ts` to use `api`, `kv`, and `bucket`, collects
  a manifest, runs locally, inspects the durable workflow run, and deploys to a live Camp URL.
- Resource permissions are inferred from source usage: `catalog` receives `get,set` and `images`
  receives `read,write`.
- Killing and restarting `hobo dev` replays the persisted state exactly, and the run-inspector
  replay diff stays unchanged.
- Anonymous `npx hobo up` returns a zero-account ephemeral URL through the existing hosted preview
  path.
- The whole app source stays provider-agnostic; no cloud-specific code appears in the edited app.

## Adversarial Coverage

- A blocked deploy gate returns an actionable fix and emits no provision/apply/deploy effects.
- A declined-card workflow fires compensation and leaves no partial order or inventory state.
- Editing resource usage re-infers permissions without stale verbs.
- The journey evidence is deterministic across temp workspaces.

## Boundary

This package composes existing proof contracts for `hobo new`, `hobo dev`, resource collection,
run inspection, anonymous preview, and `hobo up`. It does not implement the individual CLI verbs,
provider mapping, real policy/SecOps gates, payment processing, or platform-engineering internals.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\app-dev-journey-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for App Dev Journey Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
