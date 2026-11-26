# HOBO-199 VM/microVM BuildProviders Proof

HOBO-199 is proven by the independent draft package:

- package: [`src/draft/technical-proofs/vm-microvm-build-providers-contract`](../../../../src/draft/technical-proofs/vm-microvm-build-providers-contract/README.md)
- focused gate: `npm.cmd --prefix src/draft/technical-proofs/vm-microvm-build-providers-contract test`

## Design Coverage

- [`control-plane.md#plan-04`](../../control-plane.md#plan-04) defines
  `BuildProvider` as the adapter family that turns build specs into ImageRefs
  consumed by provider IacPrograms.
- [`control-plane.md#build--vm-adapters`](../../control-plane.md#build--vm-adapters)
  names Packer, Firecracker, and Vagrant as the VM/microVM adapters.
- [`architecture.md#plan-10`](../../architecture.md#plan-10) reserves the
  `build-packer`, `build-firecracker`, and `build-vagrant` package homes.
- [`adr/01-architecture-core.md#adr-0005`](../../adr/01-architecture-core.md#adr-0005)
  requires one ports/adapters shape for build artifacts.
- [`adr/07-portability-extensibility.md#adr-0042`](../../adr/07-portability-extensibility.md#adr-0042)
  requires local-dev fidelity claims to stay explicit and honest.

## Acceptance Evidence

- `@hobo/build-packer` returns deterministic VM-image ImageRefs for AWS AMI and
  Azure managed-image fixture targets with pinned Packer toolchain metadata.
- `@hobo/build-firecracker` returns a deterministic microVM rootfs ImageRef with
  required kernel modules and `executorBase: true`.
- `@hobo/build-vagrant` returns a deterministic local VM box ImageRef linked to
  the production VM ImageRef it claims to mirror, with the parity claim bound to
  the production image digest and marked as simulated local fidelity that still
  requires Camp coverage for prod readiness.
- All ImageRefs are wired into the fixture provider IacProgram and accepted by
  the reference IAC backend.
- The shared conformance gate rejects digest drift, unsupported targets,
  unsupported provider region/arch combinations, Firecracker kernel-module
  omissions, Vagrant local-fidelity drift, unbound production parity claims, and
  toolchain pin drift.

## Scope Boundary

This POC intentionally does not implement the Executor sandbox runtime,
build-wasm/build-dagger, Workload Profile selection, real Packer/Firecracker/
Vagrant subprocess execution, BuildMachine hosting, or provider-specific
deployment backends.
