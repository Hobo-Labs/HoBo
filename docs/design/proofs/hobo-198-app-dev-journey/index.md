# HOBO-198 App Developer Journey Proof

HOBO-198 is proven by the focused POC at
[`src/draft/exp-proofs/dx/app-dev-journey-contract`](../../../../src/draft/exp-proofs/dx/app-dev-journey-contract/README.md).

## Acceptance Evidence

- The CI scenario test proves `hobo new snapshop -t api` -> edited `app.ts` -> `hobo dev` ->
  `hobo inspect run --last` -> `hobo up` and asserts the live URL plus manifest permissions.
- The restart test proves killing and restarting `hobo dev` replays to the same state.
- The anonymous preview test proves `npx hobo up` returns an ephemeral zero-account URL.
- The provider-agnostic source check proves the journey needs no cloud-specific code in the app.

## Adversarial Coverage

- Gate-denial test proves `hobo up` is a clean no-op with actionable fix text.
- Declined-card test proves compensation fires and no partial state remains.
- Permission-edit test proves `kv`/`bucket` usage changes re-infer grants without stale verbs.
- Determinism test proves the journey evidence is stable across workspaces.

## Scope Boundary

The proof composes the already-owned command and runtime contracts. It does not implement the
individual CLI verbs, provider matching, real policy gates, payment rails, or platform-engineering
provider mappings.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\app-dev-journey-contract test
```
