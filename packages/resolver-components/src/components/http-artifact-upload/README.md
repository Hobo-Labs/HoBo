# `http-artifact-upload`

A generic PUT-to-endpoint resolver with a health probe. It covers static
hosts and appliances that accept an authenticated HTTP `PUT`.

- **Desired:** `uploadUrl`, `artifactDigest` (`sha256:<hex>`), `content`,
  optional `contentType`, `healthUrl`, `expectedStatus` (default 200).
- **Converge:** `GET uploadUrl`; equal digest (`x-hobo-artifact-digest` or a
  quoted ETag) → `noop` (or `adopt` without a physical id); otherwise `PUT`
  with the digest header → `create`/`update`; then probe `healthUrl` without
  credentials.
- **Observe:** `digest`, `contentType`, `cacheControl`; retained:
  `lastModified`.
- **Instances:** typed `unsupported` (an arbitrary endpoint cannot be
  enumerated; adopt through `read`).
- **Manifest:** `httpArtifactUploadManifest(hosts)` — each host exact; mark
  the upload host `credential: true`.

## Runbook

- `health probe returned N`: the upload succeeded but the site is unhealthy;
  the reconcile is rejected so the promotion does not qualify.
- `upload endpoint answered 401/403`: the credential resolved where the
  reconciler runs is wrong or expired; rotate it in the credential store.
