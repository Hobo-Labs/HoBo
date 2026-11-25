# Vibe Launch Asset Refresh Plan

HOBO-556 proof for refreshing launch-demo screenshots, recording manifests, command transcripts,
fixture data, and docs after vibe examples change.

## Audience

- Demo maintainer refreshing screenshot and recording evidence.
- Docs owner refreshing command transcripts and fixture references.
- Launch messaging owner checking proof-mode boundaries before public wording.
- Support operator routing stale or unknown evidence to the right owner.
- Accessibility reviewer checking representative asset notes.

## Scope

In scope:

- Asset inventory for screenshots, recording manifest, command transcript, fixture data, and docs.
- Source owner, proof mode, freshness rule, refresh trigger, validation route, and stale-downgrade
  behavior for every asset.
- Fixture examples for `live`, `simulated`, `reference fixture`, and `scope-out` proof modes.
- Happy path, blocked path, stale/unknown evidence path, support handoff, and accessibility notes.

Out of scope:

- Final marketing assets, recording production, live provider execution, customer data, launch
  publication, and unsupported public claims.

## Proof

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\vibe-launch-asset-refresh-plan test
```

## Architecture Evidence

- `architecture/` - protobuf data shapes and CUE constraints for the refresh plan.
- `architecture/pacts/` - Pact interaction for the refresh-plan boundary.
- `ADR.md` - parse-don't-validate derived type, experience decision, and event architecture
  evidence.
