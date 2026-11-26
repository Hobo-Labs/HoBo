# Registry Dependency-Confusion Guard Contract

This draft proof pins HOBO-391's hard-fail boundary for registry mirrors and
dependency-confusion attempts. It sits after version resolution has selected an
immutable `{ name, version, digest }` pin and before mirror cost ranking is
allowed.

## Contract Surface

- `resolvePinnedRegistryArtifact` accepts one immutable artifact pin plus a set
  of registered registry mirrors.
- Each mirror can list candidate artifacts, but only the exact pinned
  `name@version` coordinate can become eligible.
- Typosquatted names and higher-version same-name listings are reported as
  rejected shadow listings, not substituted for the pin.
- If registered mirrors list the same pinned coordinate with different digests,
  resolve fails closed and reports every conflicting digest before Dispatcher
  cost logic is called.
- Only byte-identical candidates are reported as cost-eligible for the
  HOBO-374 mirror-selection contract; this package does not rank them.
- A caller-selected digest-eligible mirror is fetched and re-hashed; byte flips
  after listing fail closed.

## Boundary

This is a deterministic POC for the adversarial guard only. It does not
implement the full version resolver, registry transport, signature/SLSA
verification, Dispatcher economics, air-gap import, registry-compromise
recovery, or production install flow.

It complements:

- [`distributed-artifact-resolver-contract`](../distributed-artifact-resolver-contract/README.md)
  for immutable digest pin selection.
- [`mirror-digest-selection-contract`](../mirror-digest-selection-contract/README.md)
  for cost ranking after byte-identical mirror verification.
- [`hobo-add-install-verification-contract`](../hobo-add-install-verification-contract/README.md)
  for install-time signature, provenance, and conformance verification.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\registry-dependency-confusion-guard-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Registry Dependency Confusion Guard Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
