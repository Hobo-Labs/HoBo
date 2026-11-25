# Provider Capability Manifest Contract POC

Independent POC for HOBO-120.

This package models the provider-authored `capabilityManifest()` surface and the
`/.well-known/capability-manifest/` publication shape. It intentionally keeps the
future `@hobo/core` schema package out of scope: this draft carries a local
schema-compatible fragment so the branch can prove the provider authoring seam.

Proven behavior:

- fixture provider emits capabilities, brokered auth, regions, and `cost.json`
  free-tier facts.
- well-known `index.json`, `capabilities.json`, `auth.json`, and `cost.json`
  serialize deterministically.
- capability negotiation rejects unsupported `require` requests with precise
  remediation.
- adversarial guards fail closed for uncovered capabilities, untrusted cost
  facts, and unserved regions.

Run:

```sh
npm test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Provider Capability Manifest Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
