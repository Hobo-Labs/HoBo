# Can-Deploy Compatibility Gate Contract

Independent POC for HOBO-123.

This package proves the M1 `can-deploy` compatibility-matrix behavior from
Plan 29 and ADR-0015:

- proposed producer versions are compared against consumers already running in
  the target Camp;
- proposed consumer versions are compared against producers already running in
  the target Camp;
- incompatible skew emits `compat.GateFailed` with machine-readable reasons and
  remediation hints;
- compatible skew emits `compat.GatePassed`;
- decisions replay from the emitted `compat.Gate*` event;
- an empty running-version event log fails closed;
- Camp enforcement mode is recorded but does not weaken compatibility semantics;
- a draft `hobo can-deploy --target` adapter returns the structured gate
  decision and an exit code.

Scope intentionally stops before observed-contract trace-mining, promotion
windows, the full Gatekeeper composition, policy/eval/cost gates, and the
Contract IR / contract-engine definitions already owned by HOBO-116 and
HOBO-119.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\can-deploy-compatibility-gate-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Can Deploy Compatibility Gate Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
