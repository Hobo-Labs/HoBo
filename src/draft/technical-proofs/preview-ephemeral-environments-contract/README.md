# Preview Ephemeral Environments Contract

This draft package proves the HOBO-332 preview environment slice without
implementing the future Matching engine, provider drivers, or CI trigger wiring.

It models the Harness-owned contract for:

- creating one deterministic ephemeral Camp per pull request;
- cloning a baseline Camp/Set into the preview Camp;
- binding resources only to `envType: "ephemeral"` variants;
- assigning a live preview URL;
- keeping preview events on a preview-only stream; and
- reaping previews at TTL with a hard-ceiling escalation path.

## Contract Surface

```js
import {
  openPullRequestPreview,
  clonePreviewEnvironment,
  reapExpiredPreview,
  reopenPullRequestPreview,
} from "@hobo-draft/preview-ephemeral-environments-contract";
```

The module is intentionally pure. Callers provide a pull request, baseline Camp
identity, optional baseline Set/resources, resource variant candidates, and a
clock. The result is a serializable preview environment record plus the events
that the future Harness runtime must append to the preview stream.

`bindEphemeralResources` only selects variants whose `envType` is `ephemeral`.
That consumes the Matching contract but does not implement Matching scores,
catalog loading, cheap-variant authoring, or provider operations.

## Proof

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\preview-ephemeral-environments-contract test
```

The tests cover the issue acceptance and adversarial cases:

- PR open creates an isolated ephemeral Camp and live URL.
- Preview resources bind to `envType: "ephemeral"` variants.
- TTL expiry emits teardown events, and missed hard ceilings escalate.
- Preview stream events do not affect the baseline projection.
- Reopening a PR deterministically reuses the Camp id and advances generation.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Preview Ephemeral Environments Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
