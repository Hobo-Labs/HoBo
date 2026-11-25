# hobo:projection Port Contract POC

This package is an independent proof for HOBO-46. It pins the M0 `hobo:projection`
contract surface:

- WIT `port` interface: `declare-projection`, `materialize`, `rebuild`, `read`, and `read-raw`.
- `projection.Declared`, `projection.Lagged`, and `projection.SinkRebound` payload helpers.
- Projection sink taxonomy and the native log-backed default sink.
- Fail-closed declaration guards for unknown event read-sets, write-capable folds, and missing sink adapters.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-projection-port-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Projection Port Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
