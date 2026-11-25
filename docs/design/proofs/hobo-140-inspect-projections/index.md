# HOBO-140 Inspect Projections Proof

HOBO-140 is proven by the focused POC at
[`src/draft/technical-proofs/hobo-inspect-projection-contract`](../../../../src/draft/technical-proofs/hobo-inspect-projection-contract/README.md).

## Acceptance Evidence

- `inspect run --last` renders a local RunView step timeline and does not need
  auth in local mode.
- `inspect run <id> --at <seq> --json` returns a stable JSON envelope and
  reproduces historical state at the requested log sequence.
- `inspect topology --json` lists each resource's resolved provider and bind
  edges.
- Rebuilding the DeploymentView from zero produces the same result as the live
  view query.

## Adversarial Evidence

- Unknown run ids fail with an explicit not-found error rather than empty
  success.
- `--at` beyond the log head is rejected.
- In-flight runs render as `PARTIAL`.
- Remote inspect without a valid SVID fails with a `hobo login` hint and returns
  no projection data.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-inspect-projection-contract test
```
