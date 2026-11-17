---
type: State machine candidate inventory
title: "HoBo state machine candidates"
description: "Lexical audit queue for implicit stateful behavior in production packages and the site."
tags: [hobo, state-machines, verification]
---

# State machine candidate inventory

This is an **audit queue**, not a list of verified state machines and not a completeness claim. At commit `e7e90647b3606039b8d82da3670047b51f1e7c8f`, a lexical scan found 421 candidate files in 59 top-level package groups. One file can implement several machines, many files can participate in one machine, and some matches are ordinary status data or test-support code. Some real machines may have no matching vocabulary and are absent from this list.

The scan covered TypeScript, TSX, JavaScript, and Astro under `packages/**/src` and `site/src`, excluding tests, fixtures, generated code, dependencies, and build output. It grouped nested provider, adapter, and runtime packages by their first directory below `packages`. It did not scan runnable applications under `examples/`, draft proofs under `src/draft/`, scripts, infrastructure, generated clients, or external submodules. HoBo's README identifies `packages/` as its production workspace and `src/draft/` as non-production proof material.

The scan looked for assignments or literals named state/status/phase/stage/mode and related terms; branches on those names; calls named transition, dispatch, reconcile, resume, advance, rollback, compensate, complete, abort, cancel, expire, recover, renew, or retry; and selected dotted lifecycle event names. It retained a file with at least two categories of signal, at least two state assignments, or at least two state branches. Only the first matching line for each signal category is linked below. These simple patterns miss aliases, many event-sourced folds and persistence-driven state, cross-file interactions, and state represented in other languages.

This snapshot predates later changes and its line references may have moved. See [state machines and verification](./state-machines.md) for the slices carried into the current verification work, their limits, and user-facing charts. Review each candidate's callers, persistence, guards, effects, recovery, and events before counting it as a distinct subsystem.

## adapters (6 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/adapters/adapter-openbao/src/openbao-secrets-port.ts` | 23 | [write L201](../packages/adapters/adapter-openbao/src/openbao-secrets-port.ts#L201), [literal L26](../packages/adapters/adapter-openbao/src/openbao-secrets-port.ts#L26), [branch L211](../packages/adapters/adapter-openbao/src/openbao-secrets-port.ts#L211) |
| `packages/adapters/adapter-1password/src/secrets-port.ts` | 5 | [literal L70](../packages/adapters/adapter-1password/src/secrets-port.ts#L70), [branch L136](../packages/adapters/adapter-1password/src/secrets-port.ts#L136) |
| `packages/adapters/adapter-bitwarden/src/secrets-port.ts` | 5 | [literal L70](../packages/adapters/adapter-bitwarden/src/secrets-port.ts#L70), [branch L122](../packages/adapters/adapter-bitwarden/src/secrets-port.ts#L122) |
| `packages/adapters/adapter-infisical/src/client.ts` | 5 | [write L203](../packages/adapters/adapter-infisical/src/client.ts#L203), [branch L143](../packages/adapters/adapter-infisical/src/client.ts#L143), [action L114](../packages/adapters/adapter-infisical/src/client.ts#L114) |
| `packages/adapters/adapter-drizzle/src/trails-compat.ts` | 2 | [branch L67](../packages/adapters/adapter-drizzle/src/trails-compat.ts#L67) |
| `packages/adapters/adapter-opensesame/src/credential-resolver.ts` | 2 | [branch L17](../packages/adapters/adapter-opensesame/src/credential-resolver.ts#L17) |

## auth-md (3 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/auth-md/src/claim.ts` | 13 | [write L195](../packages/auth-md/src/claim.ts#L195), [literal L73](../packages/auth-md/src/claim.ts#L73), [branch L197](../packages/auth-md/src/claim.ts#L197) |
| `packages/auth-md/src/assertion.ts` | 8 | [literal L45](../packages/auth-md/src/assertion.ts#L45), [branch L82](../packages/auth-md/src/assertion.ts#L82) |
| `packages/auth-md/src/rotation.ts` | 6 | [literal L58](../packages/auth-md/src/rotation.ts#L58), [branch L86](../packages/auth-md/src/rotation.ts#L86), [action L169](../packages/auth-md/src/rotation.ts#L169) |

## backend-fleet (2 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/backend-fleet/src/assignment.ts` | 29 | [write L89](../packages/backend-fleet/src/assignment.ts#L89), [literal L187](../packages/backend-fleet/src/assignment.ts#L187), [branch L358](../packages/backend-fleet/src/assignment.ts#L358), [action L553](../packages/backend-fleet/src/assignment.ts#L553) |
| `packages/backend-fleet/src/ephemeral-replica.ts` | 3 | [write L227](../packages/backend-fleet/src/ephemeral-replica.ts#L227), [branch L298](../packages/backend-fleet/src/ephemeral-replica.ts#L298), [action L249](../packages/backend-fleet/src/ephemeral-replica.ts#L249) |

## broker (9 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/broker/src/yard-placement/folds.ts` | 9 | [write L226](../packages/broker/src/yard-placement/folds.ts#L226), [literal L237](../packages/broker/src/yard-placement/folds.ts#L237), [branch L204](../packages/broker/src/yard-placement/folds.ts#L204) |
| `packages/broker/src/budget-authority.ts` | 8 | [write L605](../packages/broker/src/budget-authority.ts#L605), [literal L830](../packages/broker/src/budget-authority.ts#L830), [branch L413](../packages/broker/src/budget-authority.ts#L413) |
| `packages/broker/src/yard-placement/event-store-resolvers.ts` | 8 | [write L154](../packages/broker/src/yard-placement/event-store-resolvers.ts#L154), [literal L334](../packages/broker/src/yard-placement/event-store-resolvers.ts#L334), [event L237](../packages/broker/src/yard-placement/event-store-resolvers.ts#L237) |
| `packages/broker/src/yard-placement/generation.ts` | 8 | [literal L234](../packages/broker/src/yard-placement/generation.ts#L234), [branch L114](../packages/broker/src/yard-placement/generation.ts#L114) |
| `packages/broker/src/yard-placement/deploy.ts` | 7 | [write L936](../packages/broker/src/yard-placement/deploy.ts#L936), [literal L578](../packages/broker/src/yard-placement/deploy.ts#L578), [branch L240](../packages/broker/src/yard-placement/deploy.ts#L240) |
| `packages/broker/src/yard-placement/connectors.ts` | 6 | [literal L134](../packages/broker/src/yard-placement/connectors.ts#L134), [action L163](../packages/broker/src/yard-placement/connectors.ts#L163), [event L251](../packages/broker/src/yard-placement/connectors.ts#L251) |
| `packages/broker/src/policies.ts` | 5 | [write L250](../packages/broker/src/policies.ts#L250), [branch L203](../packages/broker/src/policies.ts#L203) |
| `packages/broker/src/yard-placement/matching.ts` | 3 | [branch L68](../packages/broker/src/yard-placement/matching.ts#L68) |
| `packages/broker/src/yard-placement/inventory.ts` | 2 | [literal L200](../packages/broker/src/yard-placement/inventory.ts#L200), [branch L142](../packages/broker/src/yard-placement/inventory.ts#L142) |

## cd (44 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/cd/src/rollout/orchestrator.ts` | 46 | [write L468](../packages/cd/src/rollout/orchestrator.ts#L468), [literal L298](../packages/cd/src/rollout/orchestrator.ts#L298), [branch L288](../packages/cd/src/rollout/orchestrator.ts#L288), [action L362](../packages/cd/src/rollout/orchestrator.ts#L362) |
| `packages/cd/src/fanout/controller.ts` | 33 | [write L609](../packages/cd/src/fanout/controller.ts#L609), [branch L372](../packages/cd/src/fanout/controller.ts#L372), [action L310](../packages/cd/src/fanout/controller.ts#L310) |
| `packages/cd/src/promotion/service.ts` | 28 | [write L1062](../packages/cd/src/promotion/service.ts#L1062), [literal L1018](../packages/cd/src/promotion/service.ts#L1018), [branch L957](../packages/cd/src/promotion/service.ts#L957), [action L772](../packages/cd/src/promotion/service.ts#L772) |
| `packages/cd/src/sources/drivers/git-pack.ts` | 22 | [write L47](../packages/cd/src/sources/drivers/git-pack.ts#L47), [branch L463](../packages/cd/src/sources/drivers/git-pack.ts#L463) |
| `packages/cd/src/inventory/inventory.ts` | 18 | [write L313](../packages/cd/src/inventory/inventory.ts#L313) |
| `packages/cd/src/ports.ts` | 12 | [literal L887](../packages/cd/src/ports.ts#L887), [action L503](../packages/cd/src/ports.ts#L503) |
| `packages/cd/src/adapters/harness.ts` | 11 | [write L174](../packages/cd/src/adapters/harness.ts#L174), [literal L318](../packages/cd/src/adapters/harness.ts#L318), [branch L197](../packages/cd/src/adapters/harness.ts#L197), [action L266](../packages/cd/src/adapters/harness.ts#L266) |
| `packages/cd/src/adapters/hosting-transition.ts` | 11 | [write L182](../packages/cd/src/adapters/hosting-transition.ts#L182), [action L39](../packages/cd/src/adapters/hosting-transition.ts#L39) |
| `packages/cd/src/agent/enrollment.ts` | 11 | [write L386](../packages/cd/src/agent/enrollment.ts#L386), [action L152](../packages/cd/src/agent/enrollment.ts#L152) |
| `packages/cd/src/feed/handler.ts` | 10 | [write L275](../packages/cd/src/feed/handler.ts#L275), [action L302](../packages/cd/src/feed/handler.ts#L302) |
| `packages/cd/src/reconcile/reconciler.ts` | 10 | [write L133](../packages/cd/src/reconcile/reconciler.ts#L133), [action L221](../packages/cd/src/reconcile/reconciler.ts#L221) |
| `packages/cd/src/sets/desired-state.ts` | 10 | [write L367](../packages/cd/src/sets/desired-state.ts#L367), [branch L401](../packages/cd/src/sets/desired-state.ts#L401) |
| `packages/cd/src/failover/controller.ts` | 9 | [write L908](../packages/cd/src/failover/controller.ts#L908), [action L891](../packages/cd/src/failover/controller.ts#L891) |
| `packages/cd/src/reconcile/transport.ts` | 9 | [write L252](../packages/cd/src/reconcile/transport.ts#L252), [action L164](../packages/cd/src/reconcile/transport.ts#L164) |
| `packages/cd/src/verification/engine.ts` | 9 | [write L188](../packages/cd/src/verification/engine.ts#L188), [action L225](../packages/cd/src/verification/engine.ts#L225) |
| `packages/cd/src/compose/rails.ts` | 8 | [write L133](../packages/cd/src/compose/rails.ts#L133), [branch L110](../packages/cd/src/compose/rails.ts#L110) |
| `packages/cd/src/fanout/state.ts` | 7 | [write L146](../packages/cd/src/fanout/state.ts#L146), [literal L94](../packages/cd/src/fanout/state.ts#L94) |
| `packages/cd/src/posture/camp-policy.ts` | 7 | [write L87](../packages/cd/src/posture/camp-policy.ts#L87), [literal L381](../packages/cd/src/posture/camp-policy.ts#L381) |
| `packages/cd/src/promotion/state.ts` | 7 | [write L392](../packages/cd/src/promotion/state.ts#L392), [branch L203](../packages/cd/src/promotion/state.ts#L203), [action L153](../packages/cd/src/promotion/state.ts#L153), [event L28](../packages/cd/src/promotion/state.ts#L28) |
| `packages/cd/src/artifacts/s3.ts` | 6 | [write L342](../packages/cd/src/artifacts/s3.ts#L342), [action L171](../packages/cd/src/artifacts/s3.ts#L171) |
| `packages/cd/src/rollout/journal.ts` | 6 | [write L608](../packages/cd/src/rollout/journal.ts#L608), [branch L610](../packages/cd/src/rollout/journal.ts#L610) |
| `packages/cd/src/sets/fold.ts` | 6 | [write L192](../packages/cd/src/sets/fold.ts#L192), [literal L123](../packages/cd/src/sets/fold.ts#L123), [branch L137](../packages/cd/src/sets/fold.ts#L137) |
| `packages/cd/src/boundary/webhook.ts` | 5 | [write L363](../packages/cd/src/boundary/webhook.ts#L363), [action L211](../packages/cd/src/boundary/webhook.ts#L211) |
| `packages/cd/src/feed/journal.ts` | 5 | [write L107](../packages/cd/src/feed/journal.ts#L107), [action L134](../packages/cd/src/feed/journal.ts#L134) |
| `packages/cd/src/sources/sources.ts` | 5 | [write L311](../packages/cd/src/sources/sources.ts#L311), [action L120](../packages/cd/src/sources/sources.ts#L120) |
| `packages/cd/src/adapters/orchestrator.ts` | 4 | [branch L190](../packages/cd/src/adapters/orchestrator.ts#L190) |
| `packages/cd/src/adapters/trails.ts` | 4 | [literal L19](../packages/cd/src/adapters/trails.ts#L19), [branch L64](../packages/cd/src/adapters/trails.ts#L64) |
| `packages/cd/src/agent/http-transport.ts` | 4 | [write L219](../packages/cd/src/agent/http-transport.ts#L219), [action L381](../packages/cd/src/agent/http-transport.ts#L381) |
| `packages/cd/src/fanout/schedule.ts` | 4 | [write L55](../packages/cd/src/fanout/schedule.ts#L55), [branch L56](../packages/cd/src/fanout/schedule.ts#L56) |
| `packages/cd/src/provenance/verifier.ts` | 4 | [write L88](../packages/cd/src/provenance/verifier.ts#L88), [branch L131](../packages/cd/src/provenance/verifier.ts#L131) |
| `packages/cd/src/service/service.ts` | 4 | [write L503](../packages/cd/src/service/service.ts#L503), [action L156](../packages/cd/src/service/service.ts#L156) |
| `packages/cd/src/sets/legacy.ts` | 4 | [write L104](../packages/cd/src/sets/legacy.ts#L104), [literal L33](../packages/cd/src/sets/legacy.ts#L33), [branch L119](../packages/cd/src/sets/legacy.ts#L119) |
| `packages/cd/src/verification/journal.ts` | 4 | [write L121](../packages/cd/src/verification/journal.ts#L121) |
| `packages/cd/src/adapters/traffic.ts` | 3 | [write L132](../packages/cd/src/adapters/traffic.ts#L132), [literal L60](../packages/cd/src/adapters/traffic.ts#L60), [branch L198](../packages/cd/src/adapters/traffic.ts#L198) |
| `packages/cd/src/posture/evaluate-camp.ts` | 3 | [write L29](../packages/cd/src/posture/evaluate-camp.ts#L29), [branch L37](../packages/cd/src/posture/evaluate-camp.ts#L37) |
| `packages/cd/src/reconcile/observation.ts` | 3 | [write L198](../packages/cd/src/reconcile/observation.ts#L198) |
| `packages/cd/src/service/routes.ts` | 3 | [write L164](../packages/cd/src/service/routes.ts#L164) |
| `packages/cd/src/telemetry/sink.ts` | 3 | [write L176](../packages/cd/src/telemetry/sink.ts#L176), [action L112](../packages/cd/src/telemetry/sink.ts#L112) |
| `packages/cd/src/verification/probes.ts` | 3 | [write L22](../packages/cd/src/verification/probes.ts#L22) |
| `packages/cd/src/freight/ledger.ts` | 2 | [write L186](../packages/cd/src/freight/ledger.ts#L186) |
| `packages/cd/src/posture/service.ts` | 2 | [write L266](../packages/cd/src/posture/service.ts#L266), [branch L152](../packages/cd/src/posture/service.ts#L152) |
| `packages/cd/src/promotion/journal.ts` | 2 | [write L144](../packages/cd/src/promotion/journal.ts#L144) |
| `packages/cd/src/telemetry/fleet.ts` | 2 | [write L159](../packages/cd/src/telemetry/fleet.ts#L159) |
| `packages/cd/src/windows/evaluate.ts` | 2 | [write L274](../packages/cd/src/windows/evaluate.ts#L274) |

## cd-gitops (2 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/cd-gitops/src/engines/index.ts` | 11 | [write L56](../packages/cd-gitops/src/engines/index.ts#L56), [literal L15](../packages/cd-gitops/src/engines/index.ts#L15), [branch L62](../packages/cd-gitops/src/engines/index.ts#L62) |
| `packages/cd-gitops/src/publisher.ts` | 4 | [write L228](../packages/cd-gitops/src/publisher.ts#L228), [branch L229](../packages/cd-gitops/src/publisher.ts#L229) |

## cd-kube-fleet (3 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/cd-kube-fleet/src/ocm/realizer.ts` | 15 | [write L704](../packages/cd-kube-fleet/src/ocm/realizer.ts#L704), [literal L529](../packages/cd-kube-fleet/src/ocm/realizer.ts#L529), [branch L277](../packages/cd-kube-fleet/src/ocm/realizer.ts#L277), [action L518](../packages/cd-kube-fleet/src/ocm/realizer.ts#L518) |
| `packages/cd-kube-fleet/src/karmada/realizer.ts` | 8 | [write L493](../packages/cd-kube-fleet/src/karmada/realizer.ts#L493), [literal L148](../packages/cd-kube-fleet/src/karmada/realizer.ts#L148), [branch L314](../packages/cd-kube-fleet/src/karmada/realizer.ts#L314), [action L137](../packages/cd-kube-fleet/src/karmada/realizer.ts#L137) |
| `packages/cd-kube-fleet/src/ocm/manifest-work.ts` | 4 | [write L181](../packages/cd-kube-fleet/src/ocm/manifest-work.ts#L181), [literal L152](../packages/cd-kube-fleet/src/ocm/manifest-work.ts#L152), [branch L184](../packages/cd-kube-fleet/src/ocm/manifest-work.ts#L184) |

## ci (10 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/ci/src/fleet-v2/sqlite-strict-store.ts` | 64 | [write L150](../packages/ci/src/fleet-v2/sqlite-strict-store.ts#L150), [literal L947](../packages/ci/src/fleet-v2/sqlite-strict-store.ts#L947), [branch L477](../packages/ci/src/fleet-v2/sqlite-strict-store.ts#L477), [action L454](../packages/ci/src/fleet-v2/sqlite-strict-store.ts#L454) |
| `packages/ci/src/fleet-v2/postgres-strict-store.ts` | 63 | [write L200](../packages/ci/src/fleet-v2/postgres-strict-store.ts#L200), [literal L1118](../packages/ci/src/fleet-v2/postgres-strict-store.ts#L1118), [branch L647](../packages/ci/src/fleet-v2/postgres-strict-store.ts#L647), [action L623](../packages/ci/src/fleet-v2/postgres-strict-store.ts#L623) |
| `packages/ci/src/store.ts` | 63 | [write L227](../packages/ci/src/store.ts#L227), [literal L1005](../packages/ci/src/store.ts#L1005), [branch L123](../packages/ci/src/store.ts#L123), [action L1175](../packages/ci/src/store.ts#L1175) |
| `packages/ci/src/scheduler.ts` | 25 | [write L41](../packages/ci/src/scheduler.ts#L41), [literal L71](../packages/ci/src/scheduler.ts#L71), [branch L45](../packages/ci/src/scheduler.ts#L45), [action L40](../packages/ci/src/scheduler.ts#L40) |
| `packages/ci/src/sqlite-store.ts` | 18 | [write L227](../packages/ci/src/sqlite-store.ts#L227), [literal L557](../packages/ci/src/sqlite-store.ts#L557), [branch L504](../packages/ci/src/sqlite-store.ts#L504), [action L482](../packages/ci/src/sqlite-store.ts#L482) |
| `packages/ci/src/execution.ts` | 15 | [write L240](../packages/ci/src/execution.ts#L240), [literal L222](../packages/ci/src/execution.ts#L222), [branch L264](../packages/ci/src/execution.ts#L264), [action L224](../packages/ci/src/execution.ts#L224) |
| `packages/ci/src/shared-budget.ts` | 6 | [literal L371](../packages/ci/src/shared-budget.ts#L371), [branch L439](../packages/ci/src/shared-budget.ts#L439) |
| `packages/ci/src/routing.ts` | 3 | [write L146](../packages/ci/src/routing.ts#L146), [branch L150](../packages/ci/src/routing.ts#L150) |
| `packages/ci/src/workspace-backend.ts` | 3 | [write L188](../packages/ci/src/workspace-backend.ts#L188), [action L171](../packages/ci/src/workspace-backend.ts#L171) |
| `packages/ci/src/fleet/offers.ts` | 2 | [branch L126](../packages/ci/src/fleet/offers.ts#L126) |

## ci-ado (3 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/ci-ado/src/live.ts` | 11 | [literal L411](../packages/ci-ado/src/live.ts#L411), [branch L332](../packages/ci-ado/src/live.ts#L332), [action L99](../packages/ci-ado/src/live.ts#L99) |
| `packages/ci-ado/src/cli.ts` | 5 | [branch L170](../packages/ci-ado/src/cli.ts#L170), [action L64](../packages/ci-ado/src/cli.ts#L64) |
| `packages/ci-ado/src/artifacts.ts` | 4 | [write L109](../packages/ci-ado/src/artifacts.ts#L109), [branch L56](../packages/ci-ado/src/artifacts.ts#L56) |

## ci-agent (3 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/ci-agent/src/agent.ts` | 17 | [write L346](../packages/ci-agent/src/agent.ts#L346), [literal L57](../packages/ci-agent/src/agent.ts#L57), [branch L418](../packages/ci-agent/src/agent.ts#L418) |
| `packages/ci-agent/src/github-queue.ts` | 8 | [write L435](../packages/ci-agent/src/github-queue.ts#L435), [literal L433](../packages/ci-agent/src/github-queue.ts#L433), [branch L224](../packages/ci-agent/src/github-queue.ts#L224) |
| `packages/ci-agent/src/git-workspace.ts` | 2 | [write L322](../packages/ci-agent/src/git-workspace.ts#L322) |

## ci-cf (3 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/ci-cf/src/local-runtime.ts` | 15 | [write L163](../packages/ci-cf/src/local-runtime.ts#L163), [literal L339](../packages/ci-cf/src/local-runtime.ts#L339), [branch L292](../packages/ci-cf/src/local-runtime.ts#L292), [action L254](../packages/ci-cf/src/local-runtime.ts#L254) |
| `packages/ci-cf/src/local-state.ts` | 14 | [write L22](../packages/ci-cf/src/local-state.ts#L22), [literal L9](../packages/ci-cf/src/local-state.ts#L9), [branch L17](../packages/ci-cf/src/local-state.ts#L17), [action L13](../packages/ci-cf/src/local-state.ts#L13) |
| `packages/ci-cf/src/backend.ts` | 4 | [write L274](../packages/ci-cf/src/backend.ts#L274), [action L50](../packages/ci-cf/src/backend.ts#L50) |

## ci-dagger (1 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/ci-dagger/src/backend.ts` | 4 | [write L122](../packages/ci-dagger/src/backend.ts#L122), [branch L138](../packages/ci-dagger/src/backend.ts#L138) |

## ci-gh-actions (52 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/ci-gh-actions/src/relay-cache/store.ts` | 84 | [write L347](../packages/ci-gh-actions/src/relay-cache/store.ts#L347), [literal L766](../packages/ci-gh-actions/src/relay-cache/store.ts#L766), [branch L483](../packages/ci-gh-actions/src/relay-cache/store.ts#L483), [action L711](../packages/ci-gh-actions/src/relay-cache/store.ts#L711) |
| `packages/ci-gh-actions/src/hosted-relay.ts` | 76 | [write L619](../packages/ci-gh-actions/src/hosted-relay.ts#L619), [literal L739](../packages/ci-gh-actions/src/hosted-relay.ts#L739), [branch L510](../packages/ci-gh-actions/src/hosted-relay.ts#L510), [action L107](../packages/ci-gh-actions/src/hosted-relay.ts#L107) |
| `packages/ci-gh-actions/src/isolated-worker/container-controller.ts` | 69 | [write L810](../packages/ci-gh-actions/src/isolated-worker/container-controller.ts#L810), [literal L373](../packages/ci-gh-actions/src/isolated-worker/container-controller.ts#L373), [branch L766](../packages/ci-gh-actions/src/isolated-worker/container-controller.ts#L766), [action L946](../packages/ci-gh-actions/src/isolated-worker/container-controller.ts#L946) |
| `packages/ci-gh-actions/src/hosted-runtime.ts` | 32 | [write L261](../packages/ci-gh-actions/src/hosted-runtime.ts#L261), [branch L113](../packages/ci-gh-actions/src/hosted-runtime.ts#L113), [action L316](../packages/ci-gh-actions/src/hosted-runtime.ts#L316) |
| `packages/ci-gh-actions/src/runner-host-realizer.ts` | 27 | [write L806](../packages/ci-gh-actions/src/runner-host-realizer.ts#L806), [literal L292](../packages/ci-gh-actions/src/runner-host-realizer.ts#L292), [branch L479](../packages/ci-gh-actions/src/runner-host-realizer.ts#L479), [action L198](../packages/ci-gh-actions/src/runner-host-realizer.ts#L198) |
| `packages/ci-gh-actions/src/hosted-control.ts` | 17 | [write L458](../packages/ci-gh-actions/src/hosted-control.ts#L458), [literal L1058](../packages/ci-gh-actions/src/hosted-control.ts#L1058), [branch L1341](../packages/ci-gh-actions/src/hosted-control.ts#L1341), [action L130](../packages/ci-gh-actions/src/hosted-control.ts#L130) |
| `packages/ci-gh-actions/src/isolated-worker/git-mirror.ts` | 17 | [literal L11](../packages/ci-gh-actions/src/isolated-worker/git-mirror.ts#L11), [branch L293](../packages/ci-gh-actions/src/isolated-worker/git-mirror.ts#L293) |
| `packages/ci-gh-actions/src/isolated-worker/lease-reconciler.ts` | 17 | [branch L89](../packages/ci-gh-actions/src/isolated-worker/lease-reconciler.ts#L89), [action L176](../packages/ci-gh-actions/src/isolated-worker/lease-reconciler.ts#L176) |
| `packages/ci-gh-actions/src/isolated-worker/github-job-poller.ts` | 16 | [write L182](../packages/ci-gh-actions/src/isolated-worker/github-job-poller.ts#L182), [branch L183](../packages/ci-gh-actions/src/isolated-worker/github-job-poller.ts#L183), [action L160](../packages/ci-gh-actions/src/isolated-worker/github-job-poller.ts#L160) |
| `packages/ci-gh-actions/src/relay-cache/rebuild.ts` | 14 | [write L258](../packages/ci-gh-actions/src/relay-cache/rebuild.ts#L258), [literal L217](../packages/ci-gh-actions/src/relay-cache/rebuild.ts#L217), [branch L211](../packages/ci-gh-actions/src/relay-cache/rebuild.ts#L211), [action L355](../packages/ci-gh-actions/src/relay-cache/rebuild.ts#L355) |
| `packages/ci-gh-actions/src/isolated-worker/deps-image.ts` | 13 | [write L230](../packages/ci-gh-actions/src/isolated-worker/deps-image.ts#L230), [literal L32](../packages/ci-gh-actions/src/isolated-worker/deps-image.ts#L32) |
| `packages/ci-gh-actions/src/webhook-repair.ts` | 11 | [write L260](../packages/ci-gh-actions/src/webhook-repair.ts#L260), [branch L124](../packages/ci-gh-actions/src/webhook-repair.ts#L124) |
| `packages/ci-gh-actions/src/fleet-verdict.ts` | 9 | [write L180](../packages/ci-gh-actions/src/fleet-verdict.ts#L180), [branch L233](../packages/ci-gh-actions/src/fleet-verdict.ts#L233) |
| `packages/ci-gh-actions/src/webhook-ingress.ts` | 8 | [literal L134](../packages/ci-gh-actions/src/webhook-ingress.ts#L134), [action L261](../packages/ci-gh-actions/src/webhook-ingress.ts#L261) |
| `packages/ci-gh-actions/src/isolated-worker/headroom-trunk-overflow.ts` | 7 | [write L78](../packages/ci-gh-actions/src/isolated-worker/headroom-trunk-overflow.ts#L78), [branch L110](../packages/ci-gh-actions/src/isolated-worker/headroom-trunk-overflow.ts#L110), [action L29](../packages/ci-gh-actions/src/isolated-worker/headroom-trunk-overflow.ts#L29) |
| `packages/ci-gh-actions/src/onboarding-pages.ts` | 7 | [write L34](../packages/ci-gh-actions/src/onboarding-pages.ts#L34), [branch L86](../packages/ci-gh-actions/src/onboarding-pages.ts#L86) |
| `packages/ci-gh-actions/src/relay-cache/repair-claims.ts` | 7 | [write L94](../packages/ci-gh-actions/src/relay-cache/repair-claims.ts#L94), [action L102](../packages/ci-gh-actions/src/relay-cache/repair-claims.ts#L102) |
| `packages/ci-gh-actions/src/relay-mcp.ts` | 7 | [write L154](../packages/ci-gh-actions/src/relay-mcp.ts#L154), [action L148](../packages/ci-gh-actions/src/relay-mcp.ts#L148) |
| `packages/ci-gh-actions/src/service.ts` | 7 | [write L170](../packages/ci-gh-actions/src/service.ts#L170), [action L198](../packages/ci-gh-actions/src/service.ts#L198), [event L8](../packages/ci-gh-actions/src/service.ts#L8) |
| `packages/ci-gh-actions/src/app-registration-http.ts` | 6 | [write L132](../packages/ci-gh-actions/src/app-registration-http.ts#L132), [action L123](../packages/ci-gh-actions/src/app-registration-http.ts#L123) |
| `packages/ci-gh-actions/src/http-handler.ts` | 6 | [write L32](../packages/ci-gh-actions/src/http-handler.ts#L32), [literal L216](../packages/ci-gh-actions/src/http-handler.ts#L216), [action L97](../packages/ci-gh-actions/src/http-handler.ts#L97) |
| `packages/ci-gh-actions/src/isolated-worker/daemon-shutdown.ts` | 6 | [write L100](../packages/ci-gh-actions/src/isolated-worker/daemon-shutdown.ts#L100), [literal L202](../packages/ci-gh-actions/src/isolated-worker/daemon-shutdown.ts#L202), [branch L199](../packages/ci-gh-actions/src/isolated-worker/daemon-shutdown.ts#L199), [action L140](../packages/ci-gh-actions/src/isolated-worker/daemon-shutdown.ts#L140) |
| `packages/ci-gh-actions/src/runner-controller-process.ts` | 6 | [write L154](../packages/ci-gh-actions/src/runner-controller-process.ts#L154), [branch L389](../packages/ci-gh-actions/src/runner-controller-process.ts#L389) |
| `packages/ci-gh-actions/src/client.ts` | 5 | [write L140](../packages/ci-gh-actions/src/client.ts#L140), [action L134](../packages/ci-gh-actions/src/client.ts#L134) |
| `packages/ci-gh-actions/src/github-oauth-session.ts` | 5 | [write L203](../packages/ci-gh-actions/src/github-oauth-session.ts#L203), [literal L312](../packages/ci-gh-actions/src/github-oauth-session.ts#L312) |
| `packages/ci-gh-actions/src/isolated-worker/composite-host.ts` | 5 | [write L20](../packages/ci-gh-actions/src/isolated-worker/composite-host.ts#L20), [action L45](../packages/ci-gh-actions/src/isolated-worker/composite-host.ts#L45) |
| `packages/ci-gh-actions/src/isolated-worker/github-lease-terminal.ts` | 5 | [write L37](../packages/ci-gh-actions/src/isolated-worker/github-lease-terminal.ts#L37), [branch L20](../packages/ci-gh-actions/src/isolated-worker/github-lease-terminal.ts#L20) |
| `packages/ci-gh-actions/src/isolated-worker/host-health.ts` | 5 | [write L123](../packages/ci-gh-actions/src/isolated-worker/host-health.ts#L123), [literal L201](../packages/ci-gh-actions/src/isolated-worker/host-health.ts#L201), [branch L130](../packages/ci-gh-actions/src/isolated-worker/host-health.ts#L130) |
| `packages/ci-gh-actions/src/isolated-worker/host-resource-pressure.ts` | 5 | [write L146](../packages/ci-gh-actions/src/isolated-worker/host-resource-pressure.ts#L146), [branch L118](../packages/ci-gh-actions/src/isolated-worker/host-resource-pressure.ts#L118) |
| `packages/ci-gh-actions/src/isolated-worker/orphan-jobs.ts` | 5 | [branch L154](../packages/ci-gh-actions/src/isolated-worker/orphan-jobs.ts#L154), [action L185](../packages/ci-gh-actions/src/isolated-worker/orphan-jobs.ts#L185) |
| `packages/ci-gh-actions/src/isolated-worker/stall-job-recovery.ts` | 5 | [write L139](../packages/ci-gh-actions/src/isolated-worker/stall-job-recovery.ts#L139), [branch L180](../packages/ci-gh-actions/src/isolated-worker/stall-job-recovery.ts#L180), [action L171](../packages/ci-gh-actions/src/isolated-worker/stall-job-recovery.ts#L171) |
| `packages/ci-gh-actions/src/offline-jit-job-recovery.ts` | 5 | [write L70](../packages/ci-gh-actions/src/offline-jit-job-recovery.ts#L70), [branch L155](../packages/ci-gh-actions/src/offline-jit-job-recovery.ts#L155), [action L146](../packages/ci-gh-actions/src/offline-jit-job-recovery.ts#L146) |
| `packages/ci-gh-actions/src/relay-mcp-server.ts` | 5 | [write L505](../packages/ci-gh-actions/src/relay-mcp-server.ts#L505), [literal L920](../packages/ci-gh-actions/src/relay-mcp-server.ts#L920), [action L587](../packages/ci-gh-actions/src/relay-mcp-server.ts#L587) |
| `packages/ci-gh-actions/src/app-registration.ts` | 4 | [write L9](../packages/ci-gh-actions/src/app-registration.ts#L9), [action L148](../packages/ci-gh-actions/src/app-registration.ts#L148) |
| `packages/ci-gh-actions/src/isolated-worker/fleet-verdict-reporter.ts` | 4 | [literal L189](../packages/ci-gh-actions/src/isolated-worker/fleet-verdict-reporter.ts#L189), [action L124](../packages/ci-gh-actions/src/isolated-worker/fleet-verdict-reporter.ts#L124) |
| `packages/ci-gh-actions/src/isolated-worker/memory-admission.ts` | 4 | [write L460](../packages/ci-gh-actions/src/isolated-worker/memory-admission.ts#L460), [branch L274](../packages/ci-gh-actions/src/isolated-worker/memory-admission.ts#L274) |
| `packages/ci-gh-actions/src/jit-runner-fleet-recovery.ts` | 4 | [branch L71](../packages/ci-gh-actions/src/jit-runner-fleet-recovery.ts#L71), [action L31](../packages/ci-gh-actions/src/jit-runner-fleet-recovery.ts#L31) |
| `packages/ci-gh-actions/src/onboarding.ts` | 4 | [literal L505](../packages/ci-gh-actions/src/onboarding.ts#L505), [branch L723](../packages/ci-gh-actions/src/onboarding.ts#L723) |
| `packages/ci-gh-actions/src/isolated-worker/routing-slip-issuer.ts` | 3 | [literal L223](../packages/ci-gh-actions/src/isolated-worker/routing-slip-issuer.ts#L223), [branch L266](../packages/ci-gh-actions/src/isolated-worker/routing-slip-issuer.ts#L266) |
| `packages/ci-gh-actions/src/queued-job-repair.ts` | 3 | [write L7](../packages/ci-gh-actions/src/queued-job-repair.ts#L7), [branch L158](../packages/ci-gh-actions/src/queued-job-repair.ts#L158) |
| `packages/ci-gh-actions/src/relay-mcp-views.ts` | 3 | [write L77](../packages/ci-gh-actions/src/relay-mcp-views.ts#L77) |
| `packages/ci-gh-actions/src/github.ts` | 2 | [write L125](../packages/ci-gh-actions/src/github.ts#L125) |
| `packages/ci-gh-actions/src/isolated-worker/held-job-prune.ts` | 2 | [write L175](../packages/ci-gh-actions/src/isolated-worker/held-job-prune.ts#L175), [branch L211](../packages/ci-gh-actions/src/isolated-worker/held-job-prune.ts#L211) |
| `packages/ci-gh-actions/src/jit-runner-correlation.ts` | 2 | [branch L128](../packages/ci-gh-actions/src/jit-runner-correlation.ts#L128) |
| `packages/ci-gh-actions/src/lease-resource-occupancy.ts` | 2 | [branch L10](../packages/ci-gh-actions/src/lease-resource-occupancy.ts#L10) |
| `packages/ci-gh-actions/src/local-runner.ts` | 2 | [write L246](../packages/ci-gh-actions/src/local-runner.ts#L246), [literal L611](../packages/ci-gh-actions/src/local-runner.ts#L611) |
| `packages/ci-gh-actions/src/mesh-nats.ts` | 2 | [write L262](../packages/ci-gh-actions/src/mesh-nats.ts#L262), [literal L73](../packages/ci-gh-actions/src/mesh-nats.ts#L73) |
| `packages/ci-gh-actions/src/mesh-node.ts` | 2 | [write L384](../packages/ci-gh-actions/src/mesh-node.ts#L384) |
| `packages/ci-gh-actions/src/mesh-records.ts` | 2 | [branch L338](../packages/ci-gh-actions/src/mesh-records.ts#L338) |
| `packages/ci-gh-actions/src/relay-trace.ts` | 2 | [branch L515](../packages/ci-gh-actions/src/relay-trace.ts#L515), [action L421](../packages/ci-gh-actions/src/relay-trace.ts#L421) |
| `packages/ci-gh-actions/src/runner-fleet-delivery.ts` | 2 | [literal L615](../packages/ci-gh-actions/src/runner-fleet-delivery.ts#L615), [branch L617](../packages/ci-gh-actions/src/runner-fleet-delivery.ts#L617) |
| `packages/ci-gh-actions/src/unlaunched-reservation-release.ts` | 2 | [write L201](../packages/ci-gh-actions/src/unlaunched-reservation-release.ts#L201), [branch L58](../packages/ci-gh-actions/src/unlaunched-reservation-release.ts#L58) |

## ci-guard (2 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/ci-guard/src/fixture-runner.ts` | 4 | [branch L54](../packages/ci-guard/src/fixture-runner.ts#L54) |
| `packages/ci-guard/src/validate.ts` | 4 | [literal L512](../packages/ci-guard/src/validate.ts#L512), [branch L155](../packages/ci-guard/src/validate.ts#L155) |

## ci-vercel (11 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/ci-vercel/src/sandbox-controller.ts` | 56 | [write L233](../packages/ci-vercel/src/sandbox-controller.ts#L233), [branch L225](../packages/ci-vercel/src/sandbox-controller.ts#L225), [action L243](../packages/ci-vercel/src/sandbox-controller.ts#L243) |
| `packages/ci-vercel/src/sandbox-egress-proxy.ts` | 19 | [write L231](../packages/ci-vercel/src/sandbox-egress-proxy.ts#L231), [action L143](../packages/ci-vercel/src/sandbox-egress-proxy.ts#L143) |
| `packages/ci-vercel/src/cache-fleet.ts` | 16 | [write L339](../packages/ci-vercel/src/cache-fleet.ts#L339), [branch L253](../packages/ci-vercel/src/cache-fleet.ts#L253), [action L333](../packages/ci-vercel/src/cache-fleet.ts#L333) |
| `packages/ci-vercel/src/sandbox-proxy-vm.ts` | 12 | [write L348](../packages/ci-vercel/src/sandbox-proxy-vm.ts#L348), [branch L599](../packages/ci-vercel/src/sandbox-proxy-vm.ts#L599), [action L294](../packages/ci-vercel/src/sandbox-proxy-vm.ts#L294) |
| `packages/ci-vercel/src/isolated-sandbox.ts` | 4 | [branch L103](../packages/ci-vercel/src/isolated-sandbox.ts#L103) |
| `packages/ci-vercel/src/_generated-assets/sandbox-proxy-bundle.ts` | 3 | [literal L3](../packages/ci-vercel/src/_generated-assets/sandbox-proxy-bundle.ts#L3), [branch L3](../packages/ci-vercel/src/_generated-assets/sandbox-proxy-bundle.ts#L3), [action L3](../packages/ci-vercel/src/_generated-assets/sandbox-proxy-bundle.ts#L3) |
| `packages/ci-vercel/src/sandbox-proxy-vm-entry.ts` | 3 | [write L35](../packages/ci-vercel/src/sandbox-proxy-vm-entry.ts#L35) |
| `packages/ci-vercel/src/stateless-composition.ts` | 3 | [write L511](../packages/ci-vercel/src/stateless-composition.ts#L511), [action L576](../packages/ci-vercel/src/stateless-composition.ts#L576) |
| `packages/ci-vercel/src/worker.ts` | 3 | [write L44](../packages/ci-vercel/src/worker.ts#L44), [literal L57](../packages/ci-vercel/src/worker.ts#L57) |
| `packages/ci-vercel/src/entry.ts` | 2 | [write L121](../packages/ci-vercel/src/entry.ts#L121), [literal L172](../packages/ci-vercel/src/entry.ts#L172) |
| `packages/ci-vercel/src/proxy-sandbox.ts` | 2 | [branch L81](../packages/ci-vercel/src/proxy-sandbox.ts#L81) |

## claims (1 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/claims/src/reducer.ts` | 36 | [write L137](../packages/claims/src/reducer.ts#L137), [literal L339](../packages/claims/src/reducer.ts#L339), [branch L95](../packages/claims/src/reducer.ts#L95) |

## cli (7 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/cli/src/cloud/yard-client.ts` | 25 | [write L1046](../packages/cli/src/cloud/yard-client.ts#L1046), [literal L135](../packages/cli/src/cloud/yard-client.ts#L135), [branch L526](../packages/cli/src/cloud/yard-client.ts#L526), [action L982](../packages/cli/src/cloud/yard-client.ts#L982) |
| `packages/cli/src/codegen/tree.ts` | 9 | [write L379](../packages/cli/src/codegen/tree.ts#L379), [literal L451](../packages/cli/src/codegen/tree.ts#L451), [action L227](../packages/cli/src/codegen/tree.ts#L227) |
| `packages/cli/src/codegen/runtime-artifacts.ts` | 8 | [write L167](../packages/cli/src/codegen/runtime-artifacts.ts#L167), [branch L308](../packages/cli/src/codegen/runtime-artifacts.ts#L308), [action L307](../packages/cli/src/codegen/runtime-artifacts.ts#L307), [event L305](../packages/cli/src/codegen/runtime-artifacts.ts#L305) |
| `packages/cli/src/build/run-build.ts` | 3 | [action L95](../packages/cli/src/build/run-build.ts#L95), [event L103](../packages/cli/src/build/run-build.ts#L103) |
| `packages/cli/src/codegen/run-codegen.ts` | 3 | [literal L57](../packages/cli/src/codegen/run-codegen.ts#L57), [action L38](../packages/cli/src/codegen/run-codegen.ts#L38) |
| `packages/cli/src/commands/up.ts` | 3 | [literal L107](../packages/cli/src/commands/up.ts#L107), [branch L104](../packages/cli/src/commands/up.ts#L104) |
| `packages/cli/src/build/container-build.ts` | 2 | [write L45](../packages/cli/src/build/container-build.ts#L45) |

## cloud (11 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/cloud/src/hosting-transition/coordinator.ts` | 35 | [write L212](../packages/cloud/src/hosting-transition/coordinator.ts#L212), [branch L610](../packages/cloud/src/hosting-transition/coordinator.ts#L610), [action L372](../packages/cloud/src/hosting-transition/coordinator.ts#L372) |
| `packages/cloud/src/orchestrator/resource-actor.ts` | 14 | [write L90](../packages/cloud/src/orchestrator/resource-actor.ts#L90), [literal L75](../packages/cloud/src/orchestrator/resource-actor.ts#L75), [branch L196](../packages/cloud/src/orchestrator/resource-actor.ts#L196), [action L178](../packages/cloud/src/orchestrator/resource-actor.ts#L178) |
| `packages/cloud/src/executor/executor.ts` | 10 | [write L312](../packages/cloud/src/executor/executor.ts#L312), [literal L86](../packages/cloud/src/executor/executor.ts#L86), [event L62](../packages/cloud/src/executor/executor.ts#L62) |
| `packages/cloud/src/gateway/gateway.ts` | 9 | [literal L123](../packages/cloud/src/gateway/gateway.ts#L123), [event L104](../packages/cloud/src/gateway/gateway.ts#L104) |
| `packages/cloud/src/projections/deployment-view.ts` | 8 | [write L75](../packages/cloud/src/projections/deployment-view.ts#L75), [literal L36](../packages/cloud/src/projections/deployment-view.ts#L36) |
| `packages/cloud/src/orchestrator/compensation.ts` | 6 | [write L164](../packages/cloud/src/orchestrator/compensation.ts#L164), [literal L42](../packages/cloud/src/orchestrator/compensation.ts#L42), [branch L165](../packages/cloud/src/orchestrator/compensation.ts#L165) |
| `packages/cloud/src/projections/credential-audit.ts` | 6 | [write L281](../packages/cloud/src/projections/credential-audit.ts#L281), [literal L218](../packages/cloud/src/projections/credential-audit.ts#L218), [branch L366](../packages/cloud/src/projections/credential-audit.ts#L366), [event L46](../packages/cloud/src/projections/credential-audit.ts#L46) |
| `packages/cloud/src/hosting-transition/model.ts` | 5 | [write L486](../packages/cloud/src/hosting-transition/model.ts#L486), [branch L293](../packages/cloud/src/hosting-transition/model.ts#L293) |
| `packages/cloud/src/planner/placement.ts` | 5 | [branch L139](../packages/cloud/src/planner/placement.ts#L139) |
| `packages/cloud/src/orchestrator/orchestrator.ts` | 4 | [write L131](../packages/cloud/src/orchestrator/orchestrator.ts#L131), [branch L132](../packages/cloud/src/orchestrator/orchestrator.ts#L132), [action L135](../packages/cloud/src/orchestrator/orchestrator.ts#L135) |
| `packages/cloud/src/planner/price-feed.ts` | 3 | [literal L135](../packages/cloud/src/planner/price-feed.ts#L135), [branch L172](../packages/cloud/src/planner/price-feed.ts#L172) |

## componentize (1 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/componentize/src/componentize.ts` | 6 | [write L307](../packages/componentize/src/componentize.ts#L307) |

## conformance (13 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/conformance/src/suites/cd-reconciler-transport.ts` | 12 | [write L120](../packages/conformance/src/suites/cd-reconciler-transport.ts#L120), [action L42](../packages/conformance/src/suites/cd-reconciler-transport.ts#L42) |
| `packages/conformance/src/suites/runtime-port/checkout-proof.ts` | 12 | [write L174](../packages/conformance/src/suites/runtime-port/checkout-proof.ts#L174), [literal L89](../packages/conformance/src/suites/runtime-port/checkout-proof.ts#L89), [action L85](../packages/conformance/src/suites/runtime-port/checkout-proof.ts#L85), [event L20](../packages/conformance/src/suites/runtime-port/checkout-proof.ts#L20) |
| `packages/conformance/src/suites/component-host/index.ts` | 9 | [write L182](../packages/conformance/src/suites/component-host/index.ts#L182), [literal L39](../packages/conformance/src/suites/component-host/index.ts#L39), [branch L446](../packages/conformance/src/suites/component-host/index.ts#L446) |
| `packages/conformance/src/corpus/replay.ts` | 8 | [write L145](../packages/conformance/src/corpus/replay.ts#L145), [literal L149](../packages/conformance/src/corpus/replay.ts#L149), [event L182](../packages/conformance/src/corpus/replay.ts#L182) |
| `packages/conformance/src/suites/cd-posture-evaluator.ts` | 7 | [literal L62](../packages/conformance/src/suites/cd-posture-evaluator.ts#L62), [branch L281](../packages/conformance/src/suites/cd-posture-evaluator.ts#L281) |
| `packages/conformance/src/suites/cd-camp-inventory.ts` | 5 | [write L283](../packages/conformance/src/suites/cd-camp-inventory.ts#L283), [action L83](../packages/conformance/src/suites/cd-camp-inventory.ts#L83) |
| `packages/conformance/src/suites/cd-traffic-shifter.ts` | 5 | [write L97](../packages/conformance/src/suites/cd-traffic-shifter.ts#L97), [action L47](../packages/conformance/src/suites/cd-traffic-shifter.ts#L47) |
| `packages/conformance/src/suites/cd-kit.ts` | 4 | [write L187](../packages/conformance/src/suites/cd-kit.ts#L187), [action L365](../packages/conformance/src/suites/cd-kit.ts#L365) |
| `packages/conformance/src/suites/runtime-port/parse.ts` | 4 | [write L20](../packages/conformance/src/suites/runtime-port/parse.ts#L20), [branch L21](../packages/conformance/src/suites/runtime-port/parse.ts#L21) |
| `packages/conformance/src/seed.ts` | 3 | [write L4](../packages/conformance/src/seed.ts#L4) |
| `packages/conformance/src/suites/anonymous/migration.ts` | 2 | [write L201](../packages/conformance/src/suites/anonymous/migration.ts#L201), [branch L319](../packages/conformance/src/suites/anonymous/migration.ts#L319) |
| `packages/conformance/src/suites/cd-fanout-controller.ts` | 2 | [write L93](../packages/conformance/src/suites/cd-fanout-controller.ts#L93) |
| `packages/conformance/src/suites/runtime-port/checks.ts` | 2 | [write L112](../packages/conformance/src/suites/runtime-port/checks.ts#L112), [event L51](../packages/conformance/src/suites/runtime-port/checks.ts#L51) |

## connectivity (9 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/connectivity/src/traffic-routing/vercel.ts` | 16 | [write L140](../packages/connectivity/src/traffic-routing/vercel.ts#L140), [literal L46](../packages/connectivity/src/traffic-routing/vercel.ts#L46), [branch L141](../packages/connectivity/src/traffic-routing/vercel.ts#L141) |
| `packages/connectivity/src/env-isolation/grants.ts` | 8 | [literal L63](../packages/connectivity/src/env-isolation/grants.ts#L63), [branch L254](../packages/connectivity/src/env-isolation/grants.ts#L254) |
| `packages/connectivity/src/tenancy/isolation.ts` | 6 | [write L92](../packages/connectivity/src/tenancy/isolation.ts#L92), [branch L95](../packages/connectivity/src/tenancy/isolation.ts#L95) |
| `packages/connectivity/src/overlay/tailscale.ts` | 5 | [write L189](../packages/connectivity/src/overlay/tailscale.ts#L189) |
| `packages/connectivity/src/local/portless.ts` | 4 | [write L45](../packages/connectivity/src/local/portless.ts#L45), [branch L83](../packages/connectivity/src/local/portless.ts#L83) |
| `packages/connectivity/src/local/named-endpoints.ts` | 3 | [write L94](../packages/connectivity/src/local/named-endpoints.ts#L94), [literal L28](../packages/connectivity/src/local/named-endpoints.ts#L28) |
| `packages/connectivity/src/connectivity-host.ts` | 2 | [write L104](../packages/connectivity/src/connectivity-host.ts#L104), [action L207](../packages/connectivity/src/connectivity-host.ts#L207) |
| `packages/connectivity/src/dns/dynamic-registrar.ts` | 2 | [literal L90](../packages/connectivity/src/dns/dynamic-registrar.ts#L90), [action L157](../packages/connectivity/src/dns/dynamic-registrar.ts#L157) |
| `packages/connectivity/src/env-isolation/local-airgap.ts` | 2 | [literal L99](../packages/connectivity/src/env-isolation/local-airgap.ts#L99), [branch L103](../packages/connectivity/src/env-isolation/local-airgap.ts#L103) |

## connectors (1 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/connectors/connector-acp/src/fixture-agent.ts` | 2 | [literal L85](../packages/connectors/connector-acp/src/fixture-agent.ts#L85), [action L96](../packages/connectors/connector-acp/src/fixture-agent.ts#L96) |

## contract-harness (1 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/contract-harness/src/pact.ts` | 3 | [write L236](../packages/contract-harness/src/pact.ts#L236), [branch L238](../packages/contract-harness/src/pact.ts#L238) |

## control-yard (2 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/control-yard/src/entity-state.ts` | 2 | [branch L183](../packages/control-yard/src/entity-state.ts#L183) |
| `packages/control-yard/src/yard-engine.ts` | 2 | [write L118](../packages/control-yard/src/yard-engine.ts#L118), [branch L118](../packages/control-yard/src/yard-engine.ts#L118) |

## core (7 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/core/src/ports/budget-policy.ts` | 13 | [write L122](../packages/core/src/ports/budget-policy.ts#L122), [branch L372](../packages/core/src/ports/budget-policy.ts#L372) |
| `packages/core/src/ports/resource-lifecycle.ts` | 7 | [write L244](../packages/core/src/ports/resource-lifecycle.ts#L244), [literal L64](../packages/core/src/ports/resource-lifecycle.ts#L64), [branch L157](../packages/core/src/ports/resource-lifecycle.ts#L157) |
| `packages/core/src/ports/claimable-resolver.ts` | 5 | [branch L252](../packages/core/src/ports/claimable-resolver.ts#L252), [action L265](../packages/core/src/ports/claimable-resolver.ts#L265) |
| `packages/core/src/ports/clock.ts` | 5 | [action L147](../packages/core/src/ports/clock.ts#L147), [event L57](../packages/core/src/ports/clock.ts#L57) |
| `packages/core/src/ports/self-hosted-data-store.ts` | 5 | [literal L271](../packages/core/src/ports/self-hosted-data-store.ts#L271), [branch L311](../packages/core/src/ports/self-hosted-data-store.ts#L311) |
| `packages/core/src/ports/jurisdiction.ts` | 4 | [write L442](../packages/core/src/ports/jurisdiction.ts#L442), [branch L443](../packages/core/src/ports/jurisdiction.ts#L443) |
| `packages/core/src/ports/messaging.ts` | 2 | [write L627](../packages/core/src/ports/messaging.ts#L627) |

## data (2 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/data/src/aggregate.ts` | 3 | [write L158](../packages/data/src/aggregate.ts#L158) |
| `packages/data/src/fold.ts` | 2 | [write L54](../packages/data/src/fold.ts#L54) |

## data-core (8 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/data-core/src/conformance.ts` | 43 | [write L770](../packages/data-core/src/conformance.ts#L770), [literal L4365](../packages/data-core/src/conformance.ts#L4365), [branch L151](../packages/data-core/src/conformance.ts#L151) |
| `packages/data-core/src/executors/copy.ts` | 29 | [write L325](../packages/data-core/src/executors/copy.ts#L325), [literal L784](../packages/data-core/src/executors/copy.ts#L784), [branch L1388](../packages/data-core/src/executors/copy.ts#L1388), [action L657](../packages/data-core/src/executors/copy.ts#L657) |
| `packages/data-core/src/executors/in-place.ts` | 25 | [write L237](../packages/data-core/src/executors/in-place.ts#L237), [literal L218](../packages/data-core/src/executors/in-place.ts#L218), [branch L231](../packages/data-core/src/executors/in-place.ts#L231), [action L626](../packages/data-core/src/executors/in-place.ts#L626) |
| `packages/data-core/src/facts.ts` | 15 | [write L292](../packages/data-core/src/facts.ts#L292), [literal L244](../packages/data-core/src/facts.ts#L244), [branch L272](../packages/data-core/src/facts.ts#L272), [event L56](../packages/data-core/src/facts.ts#L56) |
| `packages/data-core/src/executors/runtime.ts` | 13 | [write L137](../packages/data-core/src/executors/runtime.ts#L137), [literal L273](../packages/data-core/src/executors/runtime.ts#L273), [branch L335](../packages/data-core/src/executors/runtime.ts#L335), [action L498](../packages/data-core/src/executors/runtime.ts#L498) |
| `packages/data-core/src/executors/event-log.ts` | 6 | [write L244](../packages/data-core/src/executors/event-log.ts#L244), [branch L218](../packages/data-core/src/executors/event-log.ts#L218) |
| `packages/data-core/src/reference-engine.ts` | 5 | [write L614](../packages/data-core/src/reference-engine.ts#L614), [action L540](../packages/data-core/src/reference-engine.ts#L540) |
| `packages/data-core/src/crash-injection.ts` | 2 | [branch L70](../packages/data-core/src/crash-injection.ts#L70), [action L227](../packages/data-core/src/crash-injection.ts#L227) |

## data-postgres (6 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/data-postgres/src/fleet/reconcile.ts` | 27 | [write L398](../packages/data-postgres/src/fleet/reconcile.ts#L398), [literal L68](../packages/data-postgres/src/fleet/reconcile.ts#L68), [branch L217](../packages/data-postgres/src/fleet/reconcile.ts#L217), [action L208](../packages/data-postgres/src/fleet/reconcile.ts#L208) |
| `packages/data-postgres/src/conformance.ts` | 7 | [write L485](../packages/data-postgres/src/conformance.ts#L485), [literal L677](../packages/data-postgres/src/conformance.ts#L677), [branch L742](../packages/data-postgres/src/conformance.ts#L742) |
| `packages/data-postgres/src/engine/native.ts` | 6 | [write L391](../packages/data-postgres/src/engine/native.ts#L391), [action L595](../packages/data-postgres/src/engine/native.ts#L595) |
| `packages/data-postgres/src/engine/capture.ts` | 4 | [write L355](../packages/data-postgres/src/engine/capture.ts#L355) |
| `packages/data-postgres/src/engine/store.ts` | 3 | [write L101](../packages/data-postgres/src/engine/store.ts#L101), [branch L109](../packages/data-postgres/src/engine/store.ts#L109) |
| `packages/data-postgres/src/engine/pgoutput.ts` | 2 | [write L110](../packages/data-postgres/src/engine/pgoutput.ts#L110) |

## dispatcher (1 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/dispatcher/src/dispatcher.ts` | 41 | [write L333](../packages/dispatcher/src/dispatcher.ts#L333), [literal L85](../packages/dispatcher/src/dispatcher.ts#L85), [branch L299](../packages/dispatcher/src/dispatcher.ts#L299), [action L783](../packages/dispatcher/src/dispatcher.ts#L783) |

## events (4 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/events/src/upcaster-corpus.ts` | 10 | [literal L303](../packages/events/src/upcaster-corpus.ts#L303), [event L517](../packages/events/src/upcaster-corpus.ts#L517) |
| `packages/events/src/upcaster.ts` | 9 | [write L546](../packages/events/src/upcaster.ts#L546) |
| `packages/events/src/saga.ts` | 5 | [literal L53](../packages/events/src/saga.ts#L53), [action L83](../packages/events/src/saga.ts#L83) |
| `packages/events/src/reactor.ts` | 2 | [write L79](../packages/events/src/reactor.ts#L79) |

## fuzz (1 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/fuzz/src/model.ts` | 20 | [write L330](../packages/fuzz/src/model.ts#L330), [literal L317](../packages/fuzz/src/model.ts#L317), [branch L205](../packages/fuzz/src/model.ts#L205), [action L407](../packages/fuzz/src/model.ts#L407), [event L334](../packages/fuzz/src/model.ts#L334) |

## hobo (34 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/hobo/src/ci-runs.ts` | 25 | [write L282](../packages/hobo/src/ci-runs.ts#L282), [literal L402](../packages/hobo/src/ci-runs.ts#L402), [branch L153](../packages/hobo/src/ci-runs.ts#L153), [action L460](../packages/hobo/src/ci-runs.ts#L460) |
| `packages/hobo/src/broker-up-command.ts` | 23 | [write L224](../packages/hobo/src/broker-up-command.ts#L224), [literal L148](../packages/hobo/src/broker-up-command.ts#L148), [branch L165](../packages/hobo/src/broker-up-command.ts#L165) |
| `packages/hobo/src/auth-md-command.ts` | 21 | [write L412](../packages/hobo/src/auth-md-command.ts#L412), [literal L127](../packages/hobo/src/auth-md-command.ts#L127), [branch L124](../packages/hobo/src/auth-md-command.ts#L124) |
| `packages/hobo/src/hosting-execution.ts` | 18 | [write L89](../packages/hobo/src/hosting-execution.ts#L89), [action L88](../packages/hobo/src/hosting-execution.ts#L88) |
| `packages/hobo/src/claim-ceremony.ts` | 15 | [write L267](../packages/hobo/src/claim-ceremony.ts#L267), [literal L60](../packages/hobo/src/claim-ceremony.ts#L60), [branch L139](../packages/hobo/src/claim-ceremony.ts#L139) |
| `packages/hobo/src/drift-command.ts` | 13 | [literal L57](../packages/hobo/src/drift-command.ts#L57), [branch L263](../packages/hobo/src/drift-command.ts#L263) |
| `packages/hobo/src/cd-agent-runner-host.ts` | 12 | [write L219](../packages/hobo/src/cd-agent-runner-host.ts#L219), [literal L130](../packages/hobo/src/cd-agent-runner-host.ts#L130), [branch L227](../packages/hobo/src/cd-agent-runner-host.ts#L227), [action L503](../packages/hobo/src/cd-agent-runner-host.ts#L503) |
| `packages/hobo/src/feature-command.ts` | 11 | [write L171](../packages/hobo/src/feature-command.ts#L171), [literal L52](../packages/hobo/src/feature-command.ts#L52) |
| `packages/hobo/src/resolver-hosting-provider.ts` | 11 | [write L1005](../packages/hobo/src/resolver-hosting-provider.ts#L1005), [literal L430](../packages/hobo/src/resolver-hosting-provider.ts#L430), [branch L645](../packages/hobo/src/resolver-hosting-provider.ts#L645), [action L954](../packages/hobo/src/resolver-hosting-provider.ts#L954) |
| `packages/hobo/src/ci-relay-adopt.ts` | 10 | [write L430](../packages/hobo/src/ci-relay-adopt.ts#L430), [literal L247](../packages/hobo/src/ci-relay-adopt.ts#L247) |
| `packages/hobo/src/cd-deploy.ts` | 9 | [write L967](../packages/hobo/src/cd-deploy.ts#L967), [action L830](../packages/hobo/src/cd-deploy.ts#L830) |
| `packages/hobo/src/cd-runtime.ts` | 8 | [write L1006](../packages/hobo/src/cd-runtime.ts#L1006), [branch L1006](../packages/hobo/src/cd-runtime.ts#L1006), [action L1038](../packages/hobo/src/cd-runtime.ts#L1038) |
| `packages/hobo/src/ci-relay-deploy.ts` | 8 | [write L916](../packages/hobo/src/ci-relay-deploy.ts#L916), [literal L228](../packages/hobo/src/ci-relay-deploy.ts#L228), [branch L877](../packages/hobo/src/ci-relay-deploy.ts#L877) |
| `packages/hobo/src/connection-command.ts` | 8 | [write L177](../packages/hobo/src/connection-command.ts#L177), [literal L80](../packages/hobo/src/connection-command.ts#L80) |
| `packages/hobo/src/deploy-command.ts` | 8 | [write L116](../packages/hobo/src/deploy-command.ts#L116), [literal L107](../packages/hobo/src/deploy-command.ts#L107), [action L120](../packages/hobo/src/deploy-command.ts#L120) |
| `packages/hobo/src/hosting-budget-authority.ts` | 8 | [literal L469](../packages/hobo/src/hosting-budget-authority.ts#L469), [branch L344](../packages/hobo/src/hosting-budget-authority.ts#L344) |
| `packages/hobo/src/hosting-mutation-journal.ts` | 8 | [literal L113](../packages/hobo/src/hosting-mutation-journal.ts#L113), [branch L60](../packages/hobo/src/hosting-mutation-journal.ts#L60) |
| `packages/hobo/src/hosting-financial-evidence.ts` | 7 | [write L422](../packages/hobo/src/hosting-financial-evidence.ts#L422), [branch L225](../packages/hobo/src/hosting-financial-evidence.ts#L225) |
| `packages/hobo/src/ci-app-create.ts` | 6 | [write L206](../packages/hobo/src/ci-app-create.ts#L206), [literal L129](../packages/hobo/src/ci-app-create.ts#L129), [action L518](../packages/hobo/src/ci-app-create.ts#L518) |
| `packages/hobo/src/hosting-mutation-scope.ts` | 6 | [branch L52](../packages/hobo/src/hosting-mutation-scope.ts#L52) |
| `packages/hobo/src/ocsf-export.ts` | 6 | [literal L134](../packages/hobo/src/ocsf-export.ts#L134), [event L287](../packages/hobo/src/ocsf-export.ts#L287) |
| `packages/hobo/src/runbook-command.ts` | 6 | [write L92](../packages/hobo/src/runbook-command.ts#L92), [literal L86](../packages/hobo/src/runbook-command.ts#L86) |
| `packages/hobo/src/ci-secret-store.ts` | 5 | [literal L202](../packages/hobo/src/ci-secret-store.ts#L202), [action L244](../packages/hobo/src/ci-secret-store.ts#L244) |
| `packages/hobo/src/hosting-resource-store.ts` | 5 | [write L195](../packages/hobo/src/hosting-resource-store.ts#L195), [branch L156](../packages/hobo/src/hosting-resource-store.ts#L156), [action L126](../packages/hobo/src/hosting-resource-store.ts#L126) |
| `packages/hobo/src/attest-command.ts` | 4 | [literal L34](../packages/hobo/src/attest-command.ts#L34), [branch L70](../packages/hobo/src/attest-command.ts#L70) |
| `packages/hobo/src/ci-command.ts` | 4 | [write L986](../packages/hobo/src/ci-command.ts#L986), [literal L75](../packages/hobo/src/ci-command.ts#L75) |
| `packages/hobo/src/ci-relay-verify.ts` | 4 | [write L248](../packages/hobo/src/ci-relay-verify.ts#L248), [branch L301](../packages/hobo/src/ci-relay-verify.ts#L301) |
| `packages/hobo/src/identity-command.ts` | 4 | [write L159](../packages/hobo/src/identity-command.ts#L159), [literal L95](../packages/hobo/src/identity-command.ts#L95) |
| `packages/hobo/src/ci-relay-delivery.ts` | 3 | [write L529](../packages/hobo/src/ci-relay-delivery.ts#L529), [branch L531](../packages/hobo/src/ci-relay-delivery.ts#L531), [action L952](../packages/hobo/src/ci-relay-delivery.ts#L952) |
| `packages/hobo/src/claim-plane.ts` | 3 | [write L67](../packages/hobo/src/claim-plane.ts#L67) |
| `packages/hobo/src/provider-hosting-catalog.ts` | 3 | [write L600](../packages/hobo/src/provider-hosting-catalog.ts#L600) |
| `packages/hobo/src/ci-github-connect.ts` | 2 | [write L192](../packages/hobo/src/ci-github-connect.ts#L192), [action L44](../packages/hobo/src/ci-github-connect.ts#L44) |
| `packages/hobo/src/ci-mesh-status.ts` | 2 | [write L116](../packages/hobo/src/ci-mesh-status.ts#L116), [branch L39](../packages/hobo/src/ci-mesh-status.ts#L39) |
| `packages/hobo/src/hosting-serving-endpoint.ts` | 2 | [write L43](../packages/hobo/src/hosting-serving-endpoint.ts#L43), [branch L37](../packages/hobo/src/hosting-serving-endpoint.ts#L37) |

## iac (4 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/iac/iac-crossplane/src/crossplane-adapter.ts` | 9 | [write L320](../packages/iac/iac-crossplane/src/crossplane-adapter.ts#L320), [literal L270](../packages/iac/iac-crossplane/src/crossplane-adapter.ts#L270), [branch L227](../packages/iac/iac-crossplane/src/crossplane-adapter.ts#L227) |
| `packages/iac/iac-pulumi/src/iac-pulumi-automation-adapter.ts` | 7 | [write L296](../packages/iac/iac-pulumi/src/iac-pulumi-automation-adapter.ts#L296), [literal L451](../packages/iac/iac-pulumi/src/iac-pulumi-automation-adapter.ts#L451), [branch L515](../packages/iac/iac-pulumi/src/iac-pulumi-automation-adapter.ts#L515) |
| `packages/iac/iac-terraform/src/terraform-adapter.ts` | 7 | [write L297](../packages/iac/iac-terraform/src/terraform-adapter.ts#L297), [literal L434](../packages/iac/iac-terraform/src/terraform-adapter.ts#L434), [branch L501](../packages/iac/iac-terraform/src/terraform-adapter.ts#L501) |
| `packages/iac/iac-crossplane/src/kubectl-cluster.ts` | 3 | [write L237](../packages/iac/iac-crossplane/src/kubectl-cluster.ts#L237), [branch L166](../packages/iac/iac-crossplane/src/kubectl-cluster.ts#L166) |

## identity (12 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/identity/src/harness-delivery.ts` | 47 | [write L209](../packages/identity/src/harness-delivery.ts#L209), [literal L191](../packages/identity/src/harness-delivery.ts#L191), [branch L444](../packages/identity/src/harness-delivery.ts#L444), [action L414](../packages/identity/src/harness-delivery.ts#L414), [event L28](../packages/identity/src/harness-delivery.ts#L28) |
| `packages/identity/src/token-broker.ts` | 33 | [literal L112](../packages/identity/src/token-broker.ts#L112), [branch L419](../packages/identity/src/token-broker.ts#L419) |
| `packages/identity/src/secrets-port.ts` | 29 | [literal L13](../packages/identity/src/secrets-port.ts#L13), [branch L305](../packages/identity/src/secrets-port.ts#L305) |
| `packages/identity/src/connection.ts` | 25 | [write L672](../packages/identity/src/connection.ts#L672), [literal L397](../packages/identity/src/connection.ts#L397), [branch L359](../packages/identity/src/connection.ts#L359) |
| `packages/identity/src/identity-service.ts` | 17 | [literal L45](../packages/identity/src/identity-service.ts#L45), [branch L147](../packages/identity/src/identity-service.ts#L147) |
| `packages/identity/src/migration-aggregate.ts` | 11 | [write L172](../packages/identity/src/migration-aggregate.ts#L172), [literal L576](../packages/identity/src/migration-aggregate.ts#L576), [branch L238](../packages/identity/src/migration-aggregate.ts#L238), [action L240](../packages/identity/src/migration-aggregate.ts#L240) |
| `packages/identity/src/spectrum-cutover.ts` | 9 | [literal L135](../packages/identity/src/spectrum-cutover.ts#L135), [action L176](../packages/identity/src/spectrum-cutover.ts#L176) |
| `packages/identity/src/connection-events.ts` | 6 | [literal L125](../packages/identity/src/connection-events.ts#L125), [branch L208](../packages/identity/src/connection-events.ts#L208) |
| `packages/identity/src/gateway-weight.ts` | 6 | [write L140](../packages/identity/src/gateway-weight.ts#L140), [literal L26](../packages/identity/src/gateway-weight.ts#L26), [branch L102](../packages/identity/src/gateway-weight.ts#L102) |
| `packages/identity/src/harness-compose.ts` | 6 | [write L132](../packages/identity/src/harness-compose.ts#L132), [literal L125](../packages/identity/src/harness-compose.ts#L125), [branch L200](../packages/identity/src/harness-compose.ts#L200), [action L138](../packages/identity/src/harness-compose.ts#L138) |
| `packages/identity/src/feature-flag-store.ts` | 5 | [write L181](../packages/identity/src/feature-flag-store.ts#L181), [literal L462](../packages/identity/src/feature-flag-store.ts#L462), [branch L184](../packages/identity/src/feature-flag-store.ts#L184) |
| `packages/identity/src/can-migrate.ts` | 2 | [write L61](../packages/identity/src/can-migrate.ts#L61), [literal L33](../packages/identity/src/can-migrate.ts#L33) |

## kv-redis-compatible (2 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/kv-redis-compatible/src/ephemeral-conformance.ts` | 20 | [write L375](../packages/kv-redis-compatible/src/ephemeral-conformance.ts#L375), [literal L824](../packages/kv-redis-compatible/src/ephemeral-conformance.ts#L824), [action L448](../packages/kv-redis-compatible/src/ephemeral-conformance.ts#L448) |
| `packages/kv-redis-compatible/src/ephemeral-memory.ts` | 3 | [branch L159](../packages/kv-redis-compatible/src/ephemeral-memory.ts#L159), [action L32](../packages/kv-redis-compatible/src/ephemeral-memory.ts#L32) |

## management (3 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/management/src/connection-ops.ts` | 12 | [write L105](../packages/management/src/connection-ops.ts#L105), [literal L22](../packages/management/src/connection-ops.ts#L22) |
| `packages/management/src/projections.ts` | 6 | [write L35](../packages/management/src/projections.ts#L35), [branch L59](../packages/management/src/projections.ts#L59) |
| `packages/management/src/station-ops.ts` | 6 | [write L132](../packages/management/src/station-ops.ts#L132), [literal L139](../packages/management/src/station-ops.ts#L139) |

## mcp (3 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/mcp/src/secret-capture/app.ts` | 21 | [write L378](../packages/mcp/src/secret-capture/app.ts#L378), [literal L445](../packages/mcp/src/secret-capture/app.ts#L445), [branch L387](../packages/mcp/src/secret-capture/app.ts#L387) |
| `packages/mcp/src/secret-capture/html.ts` | 14 | [write L242](../packages/mcp/src/secret-capture/html.ts#L242), [literal L52](../packages/mcp/src/secret-capture/html.ts#L52), [branch L213](../packages/mcp/src/secret-capture/html.ts#L213) |
| `packages/mcp/src/server.ts` | 5 | [write L267](../packages/mcp/src/server.ts#L267), [literal L157](../packages/mcp/src/server.ts#L157) |

## packs (1 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/packs/pack-valkey-oci/src/deployment.ts` | 4 | [literal L54](../packages/packs/pack-valkey-oci/src/deployment.ts#L54), [branch L95](../packages/packs/pack-valkey-oci/src/deployment.ts#L95) |

## policy (5 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/policy/src/control-evidence-pack.ts` | 10 | [literal L221](../packages/policy/src/control-evidence-pack.ts#L221), [branch L186](../packages/policy/src/control-evidence-pack.ts#L186) |
| `packages/policy/src/posture/evaluate.ts` | 5 | [literal L195](../packages/policy/src/posture/evaluate.ts#L195), [branch L207](../packages/policy/src/posture/evaluate.ts#L207) |
| `packages/policy/src/posture/rules.ts` | 3 | [literal L74](../packages/policy/src/posture/rules.ts#L74), [branch L269](../packages/policy/src/posture/rules.ts#L269) |
| `packages/policy/src/agent-guardrails.ts` | 2 | [write L115](../packages/policy/src/agent-guardrails.ts#L115) |
| `packages/policy/src/posture/oscal.ts` | 2 | [literal L53](../packages/policy/src/posture/oscal.ts#L53), [branch L182](../packages/policy/src/posture/oscal.ts#L182) |

## pricing (3 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/pricing/src/rating.ts` | 10 | [write L757](../packages/pricing/src/rating.ts#L757), [literal L433](../packages/pricing/src/rating.ts#L433), [branch L170](../packages/pricing/src/rating.ts#L170) |
| `packages/pricing/src/decimal.ts` | 5 | [literal L102](../packages/pricing/src/decimal.ts#L102), [branch L107](../packages/pricing/src/decimal.ts#L107) |
| `packages/pricing/src/quote.ts` | 2 | [write L164](../packages/pricing/src/quote.ts#L164), [branch L148](../packages/pricing/src/quote.ts#L148) |

## providers (54 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/providers/provider-convex/src/strong-claim.ts` | 41 | [write L922](../packages/providers/provider-convex/src/strong-claim.ts#L922), [literal L347](../packages/providers/provider-convex/src/strong-claim.ts#L347), [branch L498](../packages/providers/provider-convex/src/strong-claim.ts#L498), [action L960](../packages/providers/provider-convex/src/strong-claim.ts#L960), [event L262](../packages/providers/provider-convex/src/strong-claim.ts#L262) |
| `packages/providers/provider-azure/src/resolvers.ts` | 28 | [write L618](../packages/providers/provider-azure/src/resolvers.ts#L618), [branch L2264](../packages/providers/provider-azure/src/resolvers.ts#L2264), [action L1103](../packages/providers/provider-azure/src/resolvers.ts#L1103) |
| `packages/providers/provider-digitalocean/src/resolvers.ts` | 28 | [write L966](../packages/providers/provider-digitalocean/src/resolvers.ts#L966), [branch L970](../packages/providers/provider-digitalocean/src/resolvers.ts#L970), [action L1043](../packages/providers/provider-digitalocean/src/resolvers.ts#L1043) |
| `packages/providers/provider-aws/src/resolvers.ts` | 23 | [write L1133](../packages/providers/provider-aws/src/resolvers.ts#L1133), [literal L1038](../packages/providers/provider-aws/src/resolvers.ts#L1038), [branch L1238](../packages/providers/provider-aws/src/resolvers.ts#L1238), [action L905](../packages/providers/provider-aws/src/resolvers.ts#L905) |
| `packages/providers/provider-github/src/resolver.ts` | 21 | [write L312](../packages/providers/provider-github/src/resolver.ts#L312), [literal L798](../packages/providers/provider-github/src/resolver.ts#L798), [branch L313](../packages/providers/provider-github/src/resolver.ts#L313), [action L866](../packages/providers/provider-github/src/resolver.ts#L866) |
| `packages/providers/provider-gcp/src/resolvers.ts` | 20 | [write L465](../packages/providers/provider-gcp/src/resolvers.ts#L465), [branch L530](../packages/providers/provider-gcp/src/resolvers.ts#L530), [action L777](../packages/providers/provider-gcp/src/resolvers.ts#L777) |
| `packages/providers/provider-hetzner/src/resolvers.ts` | 20 | [write L851](../packages/providers/provider-hetzner/src/resolvers.ts#L851), [branch L852](../packages/providers/provider-hetzner/src/resolvers.ts#L852), [action L945](../packages/providers/provider-hetzner/src/resolvers.ts#L945) |
| `packages/providers/provider-lakebed/src/capsule-resolver.ts` | 16 | [write L361](../packages/providers/provider-lakebed/src/capsule-resolver.ts#L361), [literal L65](../packages/providers/provider-lakebed/src/capsule-resolver.ts#L65), [branch L244](../packages/providers/provider-lakebed/src/capsule-resolver.ts#L244), [action L414](../packages/providers/provider-lakebed/src/capsule-resolver.ts#L414) |
| `packages/providers/provider-webernetes/src/pod-resolver.ts` | 16 | [write L248](../packages/providers/provider-webernetes/src/pod-resolver.ts#L248), [literal L56](../packages/providers/provider-webernetes/src/pod-resolver.ts#L56), [branch L154](../packages/providers/provider-webernetes/src/pod-resolver.ts#L154), [action L305](../packages/providers/provider-webernetes/src/pod-resolver.ts#L305) |
| `packages/providers/provider-netlify/src/resolvers.ts` | 14 | [branch L135](../packages/providers/provider-netlify/src/resolvers.ts#L135), [action L194](../packages/providers/provider-netlify/src/resolvers.ts#L194) |
| `packages/providers/provider-hostinger/src/resolvers.ts` | 13 | [write L578](../packages/providers/provider-hostinger/src/resolvers.ts#L578), [branch L587](../packages/providers/provider-hostinger/src/resolvers.ts#L587), [action L693](../packages/providers/provider-hostinger/src/resolvers.ts#L693) |
| `packages/providers/provider-npm/src/resolver.ts` | 13 | [literal L191](../packages/providers/provider-npm/src/resolver.ts#L191), [branch L554](../packages/providers/provider-npm/src/resolver.ts#L554), [action L640](../packages/providers/provider-npm/src/resolver.ts#L640) |
| `packages/providers/provider-upstash/src/driver.ts` | 13 | [literal L611](../packages/providers/provider-upstash/src/driver.ts#L611), [branch L551](../packages/providers/provider-upstash/src/driver.ts#L551) |
| `packages/providers/provider-cloudflare/src/resolvers.ts` | 11 | [write L825](../packages/providers/provider-cloudflare/src/resolvers.ts#L825), [action L553](../packages/providers/provider-cloudflare/src/resolvers.ts#L553) |
| `packages/providers/provider-kubernetes/src/api.ts` | 10 | [write L241](../packages/providers/provider-kubernetes/src/api.ts#L241), [literal L224](../packages/providers/provider-kubernetes/src/api.ts#L224), [branch L320](../packages/providers/provider-kubernetes/src/api.ts#L320) |
| `packages/providers/provider-kubernetes/src/resolvers.ts` | 10 | [write L441](../packages/providers/provider-kubernetes/src/resolvers.ts#L441), [branch L697](../packages/providers/provider-kubernetes/src/resolvers.ts#L697), [action L780](../packages/providers/provider-kubernetes/src/resolvers.ts#L780) |
| `packages/providers/provider-neon/src/client.ts` | 10 | [write L176](../packages/providers/provider-neon/src/client.ts#L176), [literal L256](../packages/providers/provider-neon/src/client.ts#L256), [branch L57](../packages/providers/provider-neon/src/client.ts#L57), [action L123](../packages/providers/provider-neon/src/client.ts#L123) |
| `packages/providers/provider-railway/src/resolvers.ts` | 10 | [write L356](../packages/providers/provider-railway/src/resolvers.ts#L356), [branch L313](../packages/providers/provider-railway/src/resolvers.ts#L313), [action L606](../packages/providers/provider-railway/src/resolvers.ts#L606) |
| `packages/providers/provider-vercel/src/sponsored-transfer.ts` | 10 | [write L646](../packages/providers/provider-vercel/src/sponsored-transfer.ts#L646), [literal L363](../packages/providers/provider-vercel/src/sponsored-transfer.ts#L363), [branch L676](../packages/providers/provider-vercel/src/sponsored-transfer.ts#L676) |
| `packages/providers/provider-prisma-postgres/src/driver.ts` | 9 | [literal L854](../packages/providers/provider-prisma-postgres/src/driver.ts#L854), [branch L674](../packages/providers/provider-prisma-postgres/src/driver.ts#L674) |
| `packages/providers/provider-upstash/src/client.ts` | 9 | [write L226](../packages/providers/provider-upstash/src/client.ts#L226), [literal L238](../packages/providers/provider-upstash/src/client.ts#L238), [branch L269](../packages/providers/provider-upstash/src/client.ts#L269), [action L131](../packages/providers/provider-upstash/src/client.ts#L131) |
| `packages/providers/provider-vercel/src/management-api.ts` | 9 | [literal L254](../packages/providers/provider-vercel/src/management-api.ts#L254), [action L84](../packages/providers/provider-vercel/src/management-api.ts#L84) |
| `packages/providers/provider-cloudflare/src/temporary-account.ts` | 8 | [write L346](../packages/providers/provider-cloudflare/src/temporary-account.ts#L346), [literal L446](../packages/providers/provider-cloudflare/src/temporary-account.ts#L446), [action L150](../packages/providers/provider-cloudflare/src/temporary-account.ts#L150) |
| `packages/providers/provider-neon/src/driver.ts` | 7 | [literal L603](../packages/providers/provider-neon/src/driver.ts#L603), [branch L204](../packages/providers/provider-neon/src/driver.ts#L204) |
| `packages/providers/provider-netlify/src/anonymous-site.ts` | 7 | [write L195](../packages/providers/provider-netlify/src/anonymous-site.ts#L195), [branch L196](../packages/providers/provider-netlify/src/anonymous-site.ts#L196), [action L272](../packages/providers/provider-netlify/src/anonymous-site.ts#L272) |
| `packages/providers/provider-prisma-postgres/src/client.ts` | 7 | [literal L155](../packages/providers/provider-prisma-postgres/src/client.ts#L155), [branch L74](../packages/providers/provider-prisma-postgres/src/client.ts#L74) |
| `packages/providers/provider-vercel/src/deployment-resolver.ts` | 7 | [write L392](../packages/providers/provider-vercel/src/deployment-resolver.ts#L392), [branch L398](../packages/providers/provider-vercel/src/deployment-resolver.ts#L398), [action L196](../packages/providers/provider-vercel/src/deployment-resolver.ts#L196) |
| `packages/providers/provider-kafka/src/messaging.ts` | 6 | [write L392](../packages/providers/provider-kafka/src/messaging.ts#L392) |
| `packages/providers/provider-ttl-sh/src/push.ts` | 6 | [literal L432](../packages/providers/provider-ttl-sh/src/push.ts#L432), [branch L402](../packages/providers/provider-ttl-sh/src/push.ts#L402), [action L423](../packages/providers/provider-ttl-sh/src/push.ts#L423) |
| `packages/providers/provider-vercel/src/resolvers.ts` | 6 | [branch L173](../packages/providers/provider-vercel/src/resolvers.ts#L173), [action L153](../packages/providers/provider-vercel/src/resolvers.ts#L153) |
| `packages/providers/runner-github/src/runner-provider.ts` | 6 | [write L52](../packages/providers/runner-github/src/runner-provider.ts#L52), [branch L63](../packages/providers/runner-github/src/runner-provider.ts#L63), [action L98](../packages/providers/runner-github/src/runner-provider.ts#L98) |
| `packages/providers/provider-kubernetes/src/driver.ts` | 5 | [literal L145](../packages/providers/provider-kubernetes/src/driver.ts#L145), [branch L67](../packages/providers/provider-kubernetes/src/driver.ts#L67) |
| `packages/providers/provider-netlify/src/client.ts` | 5 | [literal L246](../packages/providers/provider-netlify/src/client.ts#L246), [action L231](../packages/providers/provider-netlify/src/client.ts#L231) |
| `packages/providers/provider-vercel/src/git-integration-adoption.ts` | 5 | [write L163](../packages/providers/provider-vercel/src/git-integration-adoption.ts#L163), [branch L165](../packages/providers/provider-vercel/src/git-integration-adoption.ts#L165) |
| `packages/providers/provider-oci-registry/src/resolver.ts` | 4 | [write L767](../packages/providers/provider-oci-registry/src/resolver.ts#L767) |
| `packages/providers/runner-github/src/github-actions-client.ts` | 4 | [write L81](../packages/providers/runner-github/src/github-actions-client.ts#L81), [literal L196](../packages/providers/runner-github/src/github-actions-client.ts#L196), [action L115](../packages/providers/runner-github/src/github-actions-client.ts#L115) |
| `packages/providers/provider-aws/src/yard-event-fold.ts` | 3 | [literal L41](../packages/providers/provider-aws/src/yard-event-fold.ts#L41), [event L94](../packages/providers/provider-aws/src/yard-event-fold.ts#L94) |
| `packages/providers/provider-azure/src/yard-event-fold.ts` | 3 | [literal L49](../packages/providers/provider-azure/src/yard-event-fold.ts#L49), [event L106](../packages/providers/provider-azure/src/yard-event-fold.ts#L106) |
| `packages/providers/provider-convex/src/deploy.ts` | 3 | [write L146](../packages/providers/provider-convex/src/deploy.ts#L146), [literal L41](../packages/providers/provider-convex/src/deploy.ts#L41) |
| `packages/providers/provider-digitalocean/src/yard-event-fold.ts` | 3 | [literal L41](../packages/providers/provider-digitalocean/src/yard-event-fold.ts#L41), [event L93](../packages/providers/provider-digitalocean/src/yard-event-fold.ts#L93) |
| `packages/providers/provider-flux/src/app-resolver.ts` | 3 | [branch L200](../packages/providers/provider-flux/src/app-resolver.ts#L200), [action L304](../packages/providers/provider-flux/src/app-resolver.ts#L304) |
| `packages/providers/provider-gcp/src/yard-event-fold.ts` | 3 | [literal L41](../packages/providers/provider-gcp/src/yard-event-fold.ts#L41), [event L94](../packages/providers/provider-gcp/src/yard-event-fold.ts#L94) |
| `packages/providers/provider-hetzner/src/yard-event-fold.ts` | 3 | [literal L41](../packages/providers/provider-hetzner/src/yard-event-fold.ts#L41), [event L93](../packages/providers/provider-hetzner/src/yard-event-fold.ts#L93) |
| `packages/providers/provider-hostinger/src/yard-event-fold.ts` | 3 | [literal L41](../packages/providers/provider-hostinger/src/yard-event-fold.ts#L41), [event L93](../packages/providers/provider-hostinger/src/yard-event-fold.ts#L93) |
| `packages/providers/provider-kubernetes/src/yard-event-fold.ts` | 3 | [literal L41](../packages/providers/provider-kubernetes/src/yard-event-fold.ts#L41), [event L93](../packages/providers/provider-kubernetes/src/yard-event-fold.ts#L93) |
| `packages/providers/provider-neon/src/receipt.ts` | 3 | [branch L367](../packages/providers/provider-neon/src/receipt.ts#L367) |
| `packages/providers/provider-prisma-postgres/src/receipt.ts` | 3 | [branch L350](../packages/providers/provider-prisma-postgres/src/receipt.ts#L350) |
| `packages/providers/provider-upstash/src/receipt.ts` | 3 | [branch L351](../packages/providers/provider-upstash/src/receipt.ts#L351) |
| `packages/providers/provider-vercel-blob/src/ephemeral-state.ts` | 3 | [write L248](../packages/providers/provider-vercel-blob/src/ephemeral-state.ts#L248), [branch L434](../packages/providers/provider-vercel-blob/src/ephemeral-state.ts#L434), [action L444](../packages/providers/provider-vercel-blob/src/ephemeral-state.ts#L444) |
| `packages/providers/provider-convex/src/topology.ts` | 2 | [literal L48](../packages/providers/provider-convex/src/topology.ts#L48), [branch L51](../packages/providers/provider-convex/src/topology.ts#L51) |
| `packages/providers/provider-kafka/src/transport.ts` | 2 | [write L159](../packages/providers/provider-kafka/src/transport.ts#L159) |
| `packages/providers/provider-npm/src/tarball.ts` | 2 | [write L90](../packages/providers/provider-npm/src/tarball.ts#L90) |
| `packages/providers/provider-vercel/src/post-claim.ts` | 2 | [branch L143](../packages/providers/provider-vercel/src/post-claim.ts#L143) |
| `packages/providers/runner-depot/src/depot-client.ts` | 2 | [write L77](../packages/providers/runner-depot/src/depot-client.ts#L77), [literal L186](../packages/providers/runner-depot/src/depot-client.ts#L186) |

## recipes (1 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/recipes/src/recipe.ts` | 2 | [branch L280](../packages/recipes/src/recipe.ts#L280) |

## redaction-test-harness (2 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/redaction-test-harness/src/linear-sweep.ts` | 2 | [write L284](../packages/redaction-test-harness/src/linear-sweep.ts#L284) |
| `packages/redaction-test-harness/src/redaction-differential.ts` | 2 | [write L141](../packages/redaction-test-harness/src/redaction-differential.ts#L141) |

## replay (3 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/replay/src/debug-replay.ts` | 8 | [write L250](../packages/replay/src/debug-replay.ts#L250), [literal L189](../packages/replay/src/debug-replay.ts#L189) |
| `packages/replay/src/bindle-integration.ts` | 5 | [write L118](../packages/replay/src/bindle-integration.ts#L118), [literal L410](../packages/replay/src/bindle-integration.ts#L410) |
| `packages/replay/src/retention.ts` | 2 | [literal L115](../packages/replay/src/retention.ts#L115), [branch L50](../packages/replay/src/retention.ts#L50) |

## resolver-components (2 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/resolver-components/src/components/sftp-static/index.ts` | 3 | [write L115](../packages/resolver-components/src/components/sftp-static/index.ts#L115), [literal L115](../packages/resolver-components/src/components/sftp-static/index.ts#L115) |
| `packages/resolver-components/src/bundle.ts` | 2 | [branch L126](../packages/resolver-components/src/bundle.ts#L126) |

## runtime (7 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/runtime/src/placement.ts` | 12 | [write L36](../packages/runtime/src/placement.ts#L36), [literal L43](../packages/runtime/src/placement.ts#L43), [branch L37](../packages/runtime/src/placement.ts#L37) |
| `packages/runtime/src/replay/test-runtime.ts` | 10 | [write L246](../packages/runtime/src/replay/test-runtime.ts#L246), [action L55](../packages/runtime/src/replay/test-runtime.ts#L55), [event L84](../packages/runtime/src/replay/test-runtime.ts#L84) |
| `packages/runtime/src/workflow.ts` | 10 | [write L254](../packages/runtime/src/workflow.ts#L254), [literal L171](../packages/runtime/src/workflow.ts#L171), [action L328](../packages/runtime/src/workflow.ts#L328), [event L163](../packages/runtime/src/workflow.ts#L163) |
| `packages/runtime/src/replay/replayer.ts` | 7 | [write L53](../packages/runtime/src/replay/replayer.ts#L53), [literal L65](../packages/runtime/src/replay/replayer.ts#L65), [event L48](../packages/runtime/src/replay/replayer.ts#L48) |
| `packages/runtime/src/replay/equivalence.ts` | 5 | [write L119](../packages/runtime/src/replay/equivalence.ts#L119), [literal L51](../packages/runtime/src/replay/equivalence.ts#L51) |
| `packages/runtime/src/bridge/router.ts` | 4 | [write L153](../packages/runtime/src/bridge/router.ts#L153) |
| `packages/runtime/src/step.ts` | 2 | [write L60](../packages/runtime/src/step.ts#L60) |

## runtimes (15 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/runtimes/runtime-local/src/queue.ts` | 11 | [write L96](../packages/runtimes/runtime-local/src/queue.ts#L96), [literal L61](../packages/runtimes/runtime-local/src/queue.ts#L61), [action L121](../packages/runtimes/runtime-local/src/queue.ts#L121), [event L163](../packages/runtimes/runtime-local/src/queue.ts#L163) |
| `packages/runtimes/runtime-rivet/src/journal.ts` | 7 | [write L209](../packages/runtimes/runtime-rivet/src/journal.ts#L209), [literal L355](../packages/runtimes/runtime-rivet/src/journal.ts#L355), [action L135](../packages/runtimes/runtime-rivet/src/journal.ts#L135) |
| `packages/runtimes/runtime-local/src/actor-host/in-memory.ts` | 6 | [write L211](../packages/runtimes/runtime-local/src/actor-host/in-memory.ts#L211), [action L43](../packages/runtimes/runtime-local/src/actor-host/in-memory.ts#L43) |
| `packages/runtimes/runtime-local/src/queue-clock-store.ts` | 5 | [literal L21](../packages/runtimes/runtime-local/src/queue-clock-store.ts#L21), [branch L259](../packages/runtimes/runtime-local/src/queue-clock-store.ts#L259), [event L218](../packages/runtimes/runtime-local/src/queue-clock-store.ts#L218) |
| `packages/runtimes/runtime-local/src/replay.ts` | 5 | [action L77](../packages/runtimes/runtime-local/src/replay.ts#L77), [event L47](../packages/runtimes/runtime-local/src/replay.ts#L47) |
| `packages/runtimes/runtime-rivet/src/actor-host.ts` | 5 | [write L99](../packages/runtimes/runtime-rivet/src/actor-host.ts#L99), [action L162](../packages/runtimes/runtime-rivet/src/actor-host.ts#L162) |
| `packages/runtimes/runtime-local/src/eventstore/eventstore.ts` | 4 | [write L209](../packages/runtimes/runtime-local/src/eventstore/eventstore.ts#L209), [action L51](../packages/runtimes/runtime-local/src/eventstore/eventstore.ts#L51) |
| `packages/runtimes/runtime-local/src/streamer/frame-journal.ts` | 4 | [write L216](../packages/runtimes/runtime-local/src/streamer/frame-journal.ts#L216), [literal L211](../packages/runtimes/runtime-local/src/streamer/frame-journal.ts#L211), [branch L164](../packages/runtimes/runtime-local/src/streamer/frame-journal.ts#L164) |
| `packages/runtimes/runtime-cloud-native/src/cloudflare-provider.ts` | 3 | [write L109](../packages/runtimes/runtime-cloud-native/src/cloudflare-provider.ts#L109), [literal L268](../packages/runtimes/runtime-cloud-native/src/cloudflare-provider.ts#L268), [branch L116](../packages/runtimes/runtime-cloud-native/src/cloudflare-provider.ts#L116) |
| `packages/runtimes/runtime-dapr/src/messaging.ts` | 3 | [write L119](../packages/runtimes/runtime-dapr/src/messaging.ts#L119) |
| `packages/runtimes/runtime-local/src/clock.ts` | 3 | [action L114](../packages/runtimes/runtime-local/src/clock.ts#L114), [event L69](../packages/runtimes/runtime-local/src/clock.ts#L69) |
| `packages/runtimes/runtime-browser/src/browser-store.ts` | 2 | [branch L54](../packages/runtimes/runtime-browser/src/browser-store.ts#L54) |
| `packages/runtimes/runtime-dapr/src/actor-host.ts` | 2 | [write L240](../packages/runtimes/runtime-dapr/src/actor-host.ts#L240) |
| `packages/runtimes/runtime-dapr/src/config.ts` | 2 | [write L49](../packages/runtimes/runtime-dapr/src/config.ts#L49), [literal L92](../packages/runtimes/runtime-dapr/src/config.ts#L92) |
| `packages/runtimes/runtime-dapr/src/dapr-client.ts` | 2 | [write L103](../packages/runtimes/runtime-dapr/src/dapr-client.ts#L103) |

## schema-tools (1 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/schema-tools/src/codegen.ts` | 4 | [write L309](../packages/schema-tools/src/codegen.ts#L309), [literal L327](../packages/schema-tools/src/codegen.ts#L327) |

## sdk (3 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/sdk/src/waiver-chaos-execution.ts` | 32 | [write L78](../packages/sdk/src/waiver-chaos-execution.ts#L78), [literal L58](../packages/sdk/src/waiver-chaos-execution.ts#L58), [branch L123](../packages/sdk/src/waiver-chaos-execution.ts#L123) |
| `packages/sdk/src/runbook-execution.ts` | 12 | [literal L25](../packages/sdk/src/runbook-execution.ts#L25), [event L157](../packages/sdk/src/runbook-execution.ts#L157) |
| `packages/sdk/src/provider-runner-execution.ts` | 3 | [write L140](../packages/sdk/src/provider-runner-execution.ts#L140), [branch L48](../packages/sdk/src/provider-runner-execution.ts#L48) |

## site (5 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `site/src/lib/examples/controller.ts` | 21 | [write L372](../site/src/lib/examples/controller.ts#L372), [literal L140](../site/src/lib/examples/controller.ts#L140), [branch L380](../site/src/lib/examples/controller.ts#L380), [action L1790](../site/src/lib/examples/controller.ts#L1790) |
| `site/src/lib/stage/landing.ts` | 19 | [write L255](../site/src/lib/stage/landing.ts#L255), [action L233](../site/src/lib/stage/landing.ts#L233) |
| `site/src/pages/examples/index.astro` | 5 | [write L40](../site/src/pages/examples/index.astro#L40) |
| `site/src/lib/examples/runtime/browser-station.ts` | 4 | [write L135](../site/src/lib/examples/runtime/browser-station.ts#L135), [literal L292](../site/src/lib/examples/runtime/browser-station.ts#L292) |
| `site/src/lib/examples/runtime/guest-source.ts` | 2 | [write L54](../site/src/lib/examples/runtime/guest-source.ts#L54) |

## stage-gate (4 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/stage-gate/src/gate-status.ts` | 5 | [branch L70](../packages/stage-gate/src/gate-status.ts#L70) |
| `packages/stage-gate/src/runner.ts` | 4 | [write L346](../packages/stage-gate/src/runner.ts#L346), [literal L314](../packages/stage-gate/src/runner.ts#L314), [branch L347](../packages/stage-gate/src/runner.ts#L347) |
| `packages/stage-gate/src/parse.ts` | 2 | [write L119](../packages/stage-gate/src/parse.ts#L119) |
| `packages/stage-gate/src/record-constraints.ts` | 2 | [branch L129](../packages/stage-gate/src/record-constraints.ts#L129) |

## stations (6 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/stations/src/traffic-routing/cutover.ts` | 13 | [write L276](../packages/stations/src/traffic-routing/cutover.ts#L276), [literal L93](../packages/stations/src/traffic-routing/cutover.ts#L93), [branch L358](../packages/stations/src/traffic-routing/cutover.ts#L358), [action L734](../packages/stations/src/traffic-routing/cutover.ts#L734) |
| `packages/stations/src/traffic-routing/control-loop.ts` | 10 | [write L156](../packages/stations/src/traffic-routing/control-loop.ts#L156), [literal L109](../packages/stations/src/traffic-routing/control-loop.ts#L109), [branch L548](../packages/stations/src/traffic-routing/control-loop.ts#L548), [action L143](../packages/stations/src/traffic-routing/control-loop.ts#L143) |
| `packages/stations/src/rail.ts` | 8 | [write L67](../packages/stations/src/rail.ts#L67), [branch L74](../packages/stations/src/rail.ts#L74) |
| `packages/stations/src/station-service.ts` | 7 | [write L106](../packages/stations/src/station-service.ts#L106), [literal L75](../packages/stations/src/station-service.ts#L75) |
| `packages/stations/src/ci-routing.ts` | 4 | [write L136](../packages/stations/src/ci-routing.ts#L136), [action L38](../packages/stations/src/ci-routing.ts#L38) |
| `packages/stations/src/station-client.ts` | 3 | [write L87](../packages/stations/src/station-client.ts#L87) |

## status-page (5 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/status-page/src/projection.ts` | 13 | [write L226](../packages/status-page/src/projection.ts#L226), [literal L393](../packages/status-page/src/projection.ts#L393), [branch L313](../packages/status-page/src/projection.ts#L313), [action L348](../packages/status-page/src/projection.ts#L348) |
| `packages/status-page/src/render.ts` | 9 | [write L81](../packages/status-page/src/render.ts#L81) |
| `packages/status-page/src/model.ts` | 7 | [write L200](../packages/status-page/src/model.ts#L200), [branch L58](../packages/status-page/src/model.ts#L58) |
| `packages/status-page/src/types.ts` | 4 | [write L353](../packages/status-page/src/types.ts#L353), [branch L374](../packages/status-page/src/types.ts#L374), [action L433](../packages/status-page/src/types.ts#L433) |
| `packages/status-page/src/statuspage-json.ts` | 3 | [branch L128](../packages/status-page/src/statuspage-json.ts#L128) |

## storage-postgres (2 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/storage-postgres/src/store.ts` | 8 | [write L296](../packages/storage-postgres/src/store.ts#L296), [action L131](../packages/storage-postgres/src/store.ts#L131) |
| `packages/storage-postgres/src/errors.ts` | 6 | [branch L141](../packages/storage-postgres/src/errors.ts#L141), [action L195](../packages/storage-postgres/src/errors.ts#L195) |

## storage-sqlite (1 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/storage-sqlite/src/journal.ts` | 26 | [write L566](../packages/storage-sqlite/src/journal.ts#L566), [action L440](../packages/storage-sqlite/src/journal.ts#L440) |

## testing (3 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/testing/src/harness.ts` | 4 | [write L180](../packages/testing/src/harness.ts#L180) |
| `packages/testing/src/pact-chaos-matrix.ts` | 2 | [write L256](../packages/testing/src/pact-chaos-matrix.ts#L256) |
| `packages/testing/src/pact-chaos.ts` | 2 | [write L345](../packages/testing/src/pact-chaos.ts#L345) |

## trails (7 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/trails/src/aggregate.ts` | 30 | [literal L79](../packages/trails/src/aggregate.ts#L79), [branch L128](../packages/trails/src/aggregate.ts#L128), [action L107](../packages/trails/src/aggregate.ts#L107) |
| `packages/trails/src/runner.ts` | 21 | [literal L378](../packages/trails/src/runner.ts#L378), [branch L348](../packages/trails/src/runner.ts#L348), [action L200](../packages/trails/src/runner.ts#L200) |
| `packages/trails/src/upgrade-preflight.ts` | 17 | [write L238](../packages/trails/src/upgrade-preflight.ts#L238), [literal L431](../packages/trails/src/upgrade-preflight.ts#L431), [branch L268](../packages/trails/src/upgrade-preflight.ts#L268) |
| `packages/trails/src/golden.ts` | 6 | [branch L76](../packages/trails/src/golden.ts#L76) |
| `packages/trails/src/data-steps.ts` | 5 | [literal L16](../packages/trails/src/data-steps.ts#L16), [branch L79](../packages/trails/src/data-steps.ts#L79) |
| `packages/trails/src/identity-trail.ts` | 5 | [write L87](../packages/trails/src/identity-trail.ts#L87), [literal L44](../packages/trails/src/identity-trail.ts#L44), [action L237](../packages/trails/src/identity-trail.ts#L237) |
| `packages/trails/src/history.ts` | 4 | [literal L20](../packages/trails/src/history.ts#L20), [branch L56](../packages/trails/src/history.ts#L56) |

## training (1 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/training/src/prng.ts` | 2 | [write L16](../packages/training/src/prng.ts#L16) |

## yard-world (3 candidate files)

| Candidate file | Signals | First examples |
|---|---:|---|
| `packages/yard-world/src/model.ts` | 8 | [write L297](../packages/yard-world/src/model.ts#L297), [literal L441](../packages/yard-world/src/model.ts#L441), [branch L326](../packages/yard-world/src/model.ts#L326) |
| `packages/yard-world/src/cd-views.ts` | 2 | [write L321](../packages/yard-world/src/cd-views.ts#L321) |
| `packages/yard-world/src/simulator.ts` | 2 | [write L205](../packages/yard-world/src/simulator.ts#L205), [literal L254](../packages/yard-world/src/simulator.ts#L254) |
