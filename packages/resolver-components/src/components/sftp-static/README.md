# `sftp-static`

Publishes static files to an SFTP server through an **agent-local SFTP
bridge**: a small HTTPS service beside the agent, inside the target boundary,
that holds the SFTP key. The component runs in agent mode only and reaches
the bridge only at its registered loopback address (`local_addresses`); the
host attaches the bridge token from the agent-local credential store. This is
the decision-register R2 pattern for imperative targets — there is no
shell-script escape hatch.

- **Bridge API:** `GET|PUT|DELETE /v1/files/<path>` (`x-hobo-sha256`,
  `x-hobo-file-mode`), `GET /v1/files?prefix=/` (JSON list), `GET /v1/health`.
- **Desired:** `remotePath` (absolute, no `..`), `content`, `digest`, optional
  `mode` (octal, default `0644`).
- **Observe:** `mode`, `sha256`; retained: `mtime`.
- **Manifest:** `sftpStaticManifest({ host, port, localAddresses })`.

## Runbook

- `component.egress-denied` with `REBINDING`: the bridge host resolved
  outside its registered local addresses; fix the agent's hosts file or the
  manifest and re-sign.
- `component.manifest-invalid … not conductor`: the component was loaded in
  a conductor; it only runs in agent mode.
- `bridge answered 401`: the agent-local bridge token is wrong or expired.
