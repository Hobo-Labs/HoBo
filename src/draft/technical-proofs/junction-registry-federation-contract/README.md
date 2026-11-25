# Junction Registry Federation Contract

This draft proof makes HOBO-390 executable without building production Junction networking or Registry services. It composes the existing signed offline-bundle import contract with a Junction-level artifact sharing contract.

## Proven Boundary

- Yard A exports a certified Registry listing as a signed offline bundle.
- Yard B imports that bundle through its own in-boundary Registry mirror and trust boundary.
- Successful sharing emits `junction.ArtifactShared`.
- Each Yard keeps an independent Registry log; the Junction does not create a central Registry or shared mutable store.
- Peer yanks are applied as target-local Registry state so an artifact is not silently live after source revocation.

## Out of Scope

Junction identity trust establishment, trust revocation mechanics, cross-cloud connectivity inference, cross-cloud policy packs, production OCI storage, and the signed bundle/importer internals are intentionally out of this proof.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\junction-registry-federation-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Junction Registry Federation Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
