# HOBO-36 Host-Version Upgrade Contract

Independent POC for the component-host manifest pin and gated host-upgrade
contract.

## What This Proves

- Manifest IR records the certified component-host `kind`, `name`, `version`,
  and behavior profile before planning.
- Planning rejects a Camp host whose component-host version does not match the
  manifest pin, with `component_host.host-version-incompatible`.
- A host upgrade is an explicit operator-gated path; a conformance-passing
  target cannot silently rewrite the manifest pin.
- Semantics-changing host upgrades require a verified upcaster edge before the
  manifest can be repinned.
- `hobo doctor` can report host-specific lock-in and upgrade readiness,
  including when an upgrade is blocked by a missing upcaster.

## Boundary

Included: in-process planning checks, manifest IR repinning, conformance report
preconditions, verified-upcaster selection, and doctor readiness output.

Excluded: upcaster authoring framework, concrete Wasmtime adapters, specific
adapter upgrade content, and cross-host adapter migration.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\host-version-upgrade-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Host Version Upgrade Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
