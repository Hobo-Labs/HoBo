# Launch Demo Golden Path Contract

HOBO-488 proof for the launch demo golden path and proof asset checklist.

## What This Proves

- The launch demo path has one named sample app: `snapshop`.
- The primary persona, setup prerequisites, command path, screens, expected outputs, failure
  recovery scenarios, and proof assets are explicit.
- Live product behavior is separated from reference fixtures and simulated references.
- Required proof assets cover screenshots, a recording manifest, command transcript, fixture data,
  and docs.
- Scope guard rejects marketing polish, demo implementation, and unlabelled production claims.

## Command Path

1. `npx hobo new snapshop -t fullstack` as a reference fixture.
2. `hobo dev` as simulated/reference local-runtime evidence.
3. `hobo inspect run <run-id>` as a reference run-inspector fixture.
4. `hobo plan --camp preview` as simulated/reference plan evidence.
5. `hobo up --camp preview --strategy canary` only as live-product evidence when a recording
   manifest links accepted live proof.

## Expected Outputs

The contract pins scaffold summary, manifest fixture, local replay, plan warning, and live URL
evidence slots. It does not implement the CLI, the example application, or a launch site.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\launch-demo-golden-path-contract test
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for the launch demo contract.
- `architecture/pacts/` - PACT contract for the checklist boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
