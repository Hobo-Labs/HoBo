# Distributed Artifact Version Policy

Independent M0 contract for HOBO-336. This policy is the normative input for the future resolver; it does not implement dependency resolution, upcasters, yank handling, or CLI behavior.

## Accepted range syntax

Distributed dependencies accept four range forms:

- exact semver: `1.2.3`
- caret semver: `^1.2.3`
- tilde semver: `~1.2.3`
- bounded semver: `>=1.2.3 <2.0.0`

Pinned consumers may not carry a range that crosses a major boundary. A range such as `>=1.2.0 <3.0.0` fails closed because it could float a deployed Bindle across an incompatible major.

## Immutable Bindle pins

At install/plan time, a floating range is frozen to an exact artifact digest in the manifest IR. That `(artifact name, version, digest)` tuple is immutable for the Bindle version that records it. Changing the version or digest requires publishing a new Bindle version and re-running the gate; existing history is never rewritten in place.

## Tier-aware compatibility

Stable interfaces follow semver compatibility: same-major minor and patch bumps are compatible, and major bumps are incompatible without migration.

Preview and experimental interfaces are pinned more aggressively. Any version bump can require an upcaster and a new Bindle version. For `0.x` preview interfaces, every bump is treated as potentially breaking.

Deprecated interfaces remain selectable only inside their deprecation window and always carry a warning.

## Deprecation windows

When a deprecation window expires, the old pin becomes unservable. Running Sets are not force-rewritten, but redeploying that old pin is blocked and surfaced for upgrade.

## Build Metadata

Semver build metadata is ignored for compatibility precedence and normalized deterministically. Artifact identity is still the digest; build metadata never replaces a digest pin.

The immutable pin tuple records the exact version string plus digest. A build-metadata-only version change is still a pin mutation for that Bindle version, even though compatibility checks normalize build metadata for precedence.
