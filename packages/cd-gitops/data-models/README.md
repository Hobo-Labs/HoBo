# `@hobo/cd-gitops` data models

| File | Contents |
|---|---|
| `gitops.proto` | `GitopsPublisherRecord` (publisher configuration, `hobo.cd-gitops.publisher/v1`), `GitRepositoryRecord`, `EngineEndpointRecord`, `PublicationRecord`, enums `GitopsEngine`, `GitHost`. Generated into `src/_generated/gitops_pb.ts` by `pnpm run codegen`. |
| `gitops.cue` | Constraints for every message: https-only URLs without credentials, `owner/name` repositories, safe branch names, relative path prefixes without dot segments, DNS-1123 namespaces, non-empty credential references. |
| `buf.yaml` | Opts the package into codegen. |

Records hold credential **references**, never secret values.
