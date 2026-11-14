# Git host adapters

Each adapter implements `GitHostClient` (`types.ts`) over `HttpTransport`:
`head()` (branch commit), `read(path, ref)` (file at a commit, or undefined),
and `commit({ parent, message, changes })` (one commit, several files,
refused if the branch moved where the host supports a guard). No Git binary,
no clone, no host SDK.

| File | Host | Auth header | Branch-move guard |
|---|---|---|---|
| `github.ts` | GitHub / GitHub Enterprise Server | `Bearer` | `PATCH refs` with `force: false` (422) |
| `gitlab.ts` | GitLab (v4) | `Bearer` | `start_sha` (400/409) |
| `gitea.ts` | Gitea, Forgejo (API v1) | `token` | blob `sha` on update (409/422); none for new files |
| `bitbucket.ts` | Bitbucket Cloud (2.0) | `Bearer` | `parents` form field |

Statuses map to typed failures in `../http.ts`: 401/403 auth, 404 not found,
409/412/422 conflict, 429/5xx/transport unavailable, anything else invalid
response.

## Runbook

- A host answers 401/403 → `gitops-host-auth-failed`: the token needs
  repository contents write on the branch.
- A host answers 404 on the branch → create it; on a file read 404 is normal
  (the file does not exist yet).
- Repeated `gitops-host-conflict` → another writer shares the branch.
- Adding a host: implement `GitHostClient`, add it to `createGitHostClient`,
  add a `GitHost` enum value in `data-models/gitops.proto` (+ `gitops.cue`),
  and add a `contracts/pacts/cd_gitops_<host>.pact.json` first-publish pact.
