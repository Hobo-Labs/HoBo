# Webhook receivers (nudges)

`FreightSources.nudge(request)` routes on the last path segment
(`…/nudge/<receiver>`), authenticates **before** reading the payload, extracts
normalized repository keys, and schedules a poll of every source with a
matching subscription. The response is `202 {receiver, scheduled}`. It has no
path to the ledger: a payload never becomes Freight (I15).

| Receiver | Authentication | Keys from |
| --- | --- | --- |
| `github`, `ghcr` | `X-Hub-Signature-256: sha256=<HMAC-SHA256(body)>` | `repository.clone_url` / `html_url`; `package`/`registry_package` container URL or npm name |
| `gitlab` | `X-Gitlab-Token` | `project.git_http_url` |
| `bitbucket` | `X-Hub-Signature: sha256=<HMAC>` | `repository.links.html.href` |
| `gitea`, `forgejo` | `X-Gitea-Signature` / `X-Forgejo-Signature` (hex HMAC) | `repository.clone_url` |
| `harbor` | `Authorization` equals the configured auth header | `event_data.resources[].resource_url` |
| `dockerhub` | `?token=` (Docker Hub signs nothing) | `repository.repo_name` |
| `ecr` | `Authorization: Bearer` (EventBridge API destination) | `account`, `region`, `detail.repository-name` |
| `artifact-registry` | `?token=` (Pub/Sub push) | base64 `message.data` `digest` / `tag` |
| `cloudevents` | `Authorization: Bearer` | CDEvents `subject.id` purl, `subject.content.url`, repository URLs, `ce-subject` |

Secrets resolve through `webhookSecrets.resolve("webhook/<receiver>", "cd:source:nudge")`
as `{secret}` (HMAC) or `{token}` (shared token); comparison is constant time.
Keys (`keys.ts`): `oci:<registry>/<repository>`, `git:<host><path>`,
`pkg:<type>/<name>`, `url:<origin><path>`. `HOBO_CI` and `HOBO_RAIL`
subscriptions are never nudged from outside.

## Runbook

- **`401`**: the sender's secret differs from the stored one, or the stored one
  is missing. Nothing was scheduled. Re-share the secret.
- **`404`**: the URL's last segment is not a receiver id.
- **`413`**: bodies over 1 MiB are refused; senders should send notifications,
  not artifacts.
- **`202` but nothing polls**: `scheduled` is empty, so no subscription key
  matched; compare the payload's repository with the subscription locator.
