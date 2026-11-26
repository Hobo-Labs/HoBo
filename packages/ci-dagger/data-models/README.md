# Dagger schema ownership

`readiness.proto` owns the SDK readiness message. `buf.yaml` opts into repository
codegen; runtime code imports `src/_generated/readiness_pb.ts`. `ci_dagger.cue`
constrains integration identity, implemented status, available SDK execution, the
official SDK target, and nonempty pending gates. Scoped schema-tools generation
and drift checks exercise the valid/invalid JSON fixture instances.

`parseReadiness()` parses protobuf JSON into the generated record, applies
the same invariants, and freezes a derived `DaggerReadiness` view. The Pact
consumer test checks the normalized protobuf JSON surface.

Shared account, offer, and lease records belong to `@hobo/ci`. Future execution
commands, checkpoint/lifecycle events, and results need their own protobuf/CUE
records before use; readiness does not model that lifecycle.

`checks.proto` owns native `CheckConfig`, imported from generated
`src/_generated/checks_pb.ts`. `parseDaggerCheckConfig` applies defaults for local
engine/workspace and rejects Cloud selectors, unsupported versions, flag-shaped
selectors, paths outside the repository, and excessive parallelism. `ci_dagger.cue`
contains both named constraints with a `#CiDagger` union because schema-tools vets
every package fixture against its file-named root definition. The
`local-checks.json` and `cloud-checks.json` fixtures pin native configuration.
`minimal-checks.json` exercises omitted engine/workspace defaults; the NUL fixtures
keep schema rejection aligned with the runtime parser. The existing fixtures
continue to pin SDK readiness. Runtime-dependent executable
version matching and child environment isolation are protected by the subprocess
Pact, not by CUE. There are no new persisted commands, events or read models.

`timeoutSeconds` is an overall native execution deadline (zero/omitted selects
900 seconds, maximum 86400); `environment` names an optional workspace overlay.
The Podman/CI fixture exercises explicit container-runtime transport selection
and both fields, with invalid deadline/environment fixtures protecting the bounds.
