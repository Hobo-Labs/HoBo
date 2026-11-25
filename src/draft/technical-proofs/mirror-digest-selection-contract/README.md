# Mirror Digest Selection Contract

This draft proof pins HOBO-374's digest-as-selection-key boundary for registry mirrors.
It consumes only already verified `hobo add` catalog entries and mirror verification results.
Dispatcher cost/latency ranking is a tiebreak inside a single byte-identical digest set.

## Contract Surface

- `selectDigestPinnedMirror` accepts a resolved `name@version`, its resolved digest, and mirror candidates.
- Every mirror verifies to a digest before cost ranking is allowed.
- If any candidate is unverified, cost ranking is not called and no mirror is selected.
- If verified candidates disagree with the resolved digest, cost ranking is not called; the result is escalated to the HOBO-391 hard-fail path.
- Dispatcher ranking receives only verified, byte-identical candidates and chooses a mirror by cost/latency.
- Fetched bytes are rehashed against the agreed digest before the selected artifact is returned.

## Boundary

This is a deterministic POC for mirror selection only. It does not implement version resolution,
the Dispatcher cost model, namespace-shadowing enforcement, air-gap mirror import, production
registry transport, or HOBO-391's digest-mismatch hard-fail UX.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\mirror-digest-selection-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Mirror Digest Selection Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
