# HoBo Manifest Contract POC

This draft pins `hobo.manifest/v1`, the deployment IR emitted by resource
collection and consumed by Planner/Orchestrator.

It covers:

- `schema: "hobo.manifest/v1"` plus a required `componentHost` kind/version pin.
- Resource entries for `data.v1`, `component.v1`, and `website.v1`.
- Lazy tokens such as `{db.connectionString}`.
- Humanitec-style placeholders such as
  `${resources.data.postgres#db.outputs.connectionString}` and `${context.*}`.
- Aspire fallback environment conventions:
  `ConnectionStrings__<name>` and `services__<name>__...`.
- Stable content hashing from canonical JSON.
- Fail-closed validation for dangling tokens and unresolved capability links.
- A versioned-schema upcaster registry for `hobo.manifest/v1` -> `hobo.manifest/v1.1`.
- Current-schema dispatch that rejects unknown schemas, missing intermediate upcasters,
  and unrecorded lossy migrations.
- Idempotent current-manifest handling and deterministic post-upcast hashing.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-manifest-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Manifest Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
