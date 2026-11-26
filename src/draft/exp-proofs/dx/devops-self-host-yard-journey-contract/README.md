# DevOps Self-Host Yard Journey Contract POC

HOBO-219 proof for the DevOps bootstrap story:
`hobo up ./platform --seed` -> `hobo up ./platform --camp host-azure` ->
`hobo up ./platform --restore <log>` -> rerun `hobo up ./platform` for upgrade.

## What This Proves

- The CLI journey records the exact seed, self-host, restore, and upgrade
  command sequence.
- The operator login SVID is used once as `identity.SeedTokenUsed`, then
  retired after real Identity brokers the Yard token.
- The self-hosted Yard is reachable on `host-azure`, with real Identity as the
  only broker after handoff.
- A last-good event log rebuilds the control plane through `--restore` without
  live command replay.
- Re-running `hobo up ./platform` uses the same gate for upgrades.

## Adversarial Coverage

- A phase-two provider failure leaves the seed recoverable and never reports a
  half-built Yard as live.
- Seed credential reuse after handoff is denied without a second
  `identity.SeedTokenUsed`.
- Corrupt and partial restore logs are refused before any rebuilt Yard state is
  returned.
- A failed upgrade rolls back to the previous active set.
- The operator laptop remains a CLI client only; control-plane state belongs to
  the self-hosted Yard.

## Boundary

This package composes the existing self-host bootstrap saga contract. It does
not implement real Yard control-plane components, bootstrap ordering internals,
CI runner fabric, hosted Azure APIs, or offline bundle distribution.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\devops-self-host-yard-journey-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Devops Self Host Yard Journey Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
