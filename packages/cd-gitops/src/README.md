# `@hobo/cd-gitops` sources

| File | Role |
|---|---|
| `config.ts` | `parsePublisherConfig`: protobuf JSON → branded `PublisherConfig` (gitops.cue rules, defaults). |
| `render.ts` | `renderPublication`: Set → engine document + Set ConfigMap, byte-stable. |
| `publisher.ts` | `createGitopsPublisher` (the frozen `PublisherPort`) and `createPublisherRegistry`. |
| `hosts/` | Git host HTTP adapters (GitHub, GitLab, Gitea/Forgejo, Bitbucket). |
| `engines/` | Argo CD / Flux status → convergence verdict. |
| `http.ts` | Bounded calls, status → typed failure, credential lookup. |
| `errors.ts` | `GITOPS_FAILURES` with remediation. |
| `_generated/` | protoc-gen-es output of `data-models/gitops.proto` (never hand-edited). |

## Runbook

Failure codes, symptoms and actions: see the package
[README runbook](../README.md#runbook).
