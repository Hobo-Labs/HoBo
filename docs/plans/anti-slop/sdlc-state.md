---
type: Delivery State
title: "anti-slop SDLC state"
description: "Stacked PR chain for vendoring dmmulroy/anti-slop and gating it on changed files."
tags: [hobo, sdlc, anti-slop, oxlint]
---

# anti-slop — stack state

```text
main
 └── sdlc/anti-slop-01-vendor      #1179 plugin, skill mirrors, oxlint 1.79, lint:slop:changed
  └── sdlc/anti-slop-02-precommit  #1180 relevant-check-policy + tests
   └── sdlc/anti-slop-03-scripts-warnings  #1185 ignore agent-skill dirs; scripts/lib/inspectable
    └── sdlc/anti-slop-04-test     #1187 root competitor/council tests
     └── sdlc/anti-slop-05-examples  #1192 examples/ oxlint-clean
      └── sdlc/anti-slop-06-site     #1193 site/ oxlint-clean (json-inspect helper)
       └── sdlc/anti-slop-07-connectors  #1195 connectors + ci-guard + manifest-plan
        └── sdlc/anti-slop-08-data       #1197 @hobo/data
         └── sdlc/anti-slop-09-recipes   #1199 @hobo/recipes
          └── sdlc/anti-slop-10-mcp      #1202 @hobo/mcp + cloud gateway
           └── sdlc/anti-slop-11-providers-small  #1203 config/agentv/cedar/opa/ax/blacksmith
            └── sdlc/anti-slop-12-providers-runners  #1204 depot + flux
             └── sdlc/anti-slop-13-providers-github-lakebed  #1205 github + lakebed
              └── sdlc/anti-slop-14-providers-railway-convex  #1207 railway + convex
               └── sdlc/anti-slop-15-providers-kafka-webernetes-ttl  #1209 webernetes + kafka + ttl-sh
                └── sdlc/anti-slop-16-providers-neon-prisma  #1211 neon + prisma-postgres
                 └── sdlc/anti-slop-17-providers-browser-wasm  #1212 browser-wasm
                  └── sdlc/anti-slop-18-providers-upstash  #1213 upstash
                   └── sdlc/anti-slop-19-providers-netlify  #1214 netlify
                    └── sdlc/anti-slop-20-providers-vercel  #1215 vercel
                     └── sdlc/anti-slop-21-providers-hostinger  #1216 hostinger
                      └── sdlc/anti-slop-22-providers-hetzner  #1218 hetzner
                       └── sdlc/anti-slop-23-providers-aws  #1220 aws
                        └── sdlc/anti-slop-24-providers-gcp  #1222 gcp
                         └── sdlc/anti-slop-25-providers-azure  #1224 azure
                          └── sdlc/anti-slop-26-providers-cloudflare  #1231 cloudflare
                           └── sdlc/anti-slop-27-providers-digitalocean  #1235 digitalocean
                            └── sdlc/anti-slop-28-code  #1238 @hobo/code
                             └── sdlc/anti-slop-29-hobo  #1241 packages/hobo
                              └── sdlc/anti-slop-30-core  #1242 packages/core
                               └── sdlc/anti-slop-31-broker  #1243 packages/broker
                                └── sdlc/anti-slop-32-connectivity  #1244 packages/connectivity
                                 └── sdlc/anti-slop-33-bindles  #1245 packages/bindles
                                  └── sdlc/anti-slop-34-contracts  #1249 packages/contracts
                                   └── sdlc/anti-slop-35-stations  #1251 packages/stations
                                    └── sdlc/anti-slop-36-storage-sqlite  #1254 packages/storage-sqlite
                                     └── sdlc/anti-slop-37-policy  #1256 packages/policy
                                      └── sdlc/anti-slop-38-dispatcher  #1258 packages/dispatcher
                                       └── sdlc/anti-slop-39-runtimes-small  #1261 wasm+celld+cloud-native
                                        └── sdlc/anti-slop-40-runtimes-browser-oci  #1263 browser+oci
                                         └── sdlc/anti-slop-41-runtimes-dapr-rivet  #1266 dapr+rivet
                                          └── sdlc/anti-slop-42-runtimes-local  #1274 runtime-local
                                           └── sdlc/anti-slop-43-runtime-conformance  #1276 runtime+conformance
                                            └── sdlc/anti-slop-44-identity  #1278 identity
                                             └── sdlc/anti-slop-45-adapters  #1280 adapters
                                              └── sdlc/anti-slop-46-provider-kubernetes  #1284 kubernetes
                                               └── sdlc/anti-slop-47-draft-epic  #1286 epic-proofs
                                                └── sdlc/anti-slop-48-draft-technical-tiny  #1289 tiny technical proofs
                                                 └── sdlc/anti-slop-49-draft-technical-mid  #1291 pact+replay+policy-ir
                                                  └── sdlc/anti-slop-50-draft-technical-ifc  #1294 ifc+ctx-config+membrane
                                                   └── sdlc/anti-slop-51-draft-s1-15  #1296 bind-wiring-topology
                                                    └── sdlc/anti-slop-52-draft-runtime-primitives  #1297 runtime-ts+multi-region-dr
                                                     └── sdlc/anti-slop-53-draft-escape-ir-postgres  #1299 raw-driver+contract-ir+postgres
                                                      └── sdlc/anti-slop-54-draft-cloudflare-camp  #1301 cloudflare-contract+camp-mapping
                                                       └── sdlc/anti-slop-55-draft-collection-azure  #1303 collection-engine+azure-full
                                                        └── sdlc/anti-slop-56-draft-ifc-actor-data  #1305 ifc-handler+actor-host+data-paradigm
                                                         └── sdlc/anti-slop-57-draft-portability-usage-convex  #1307 s4-08+s1-17+convex-adapter
                                                          └── sdlc/anti-slop-58-draft-planner-loop-closure  #1309 planner+local-loop+closure-builder
                                                           └── sdlc/anti-slop-59-draft-cloud-provider-contracts  #1311 azure+gcp+aws-contracts
                                                            └── sdlc/anti-slop-60-draft-cdktf-cqrs-projection  #1313 cdktf+cqrs+native-log
                                                             └── sdlc/anti-slop-61-draft-container-wrpc-drift  #1315 container-fallback+wrpc+drift
                                                              └── sdlc/anti-slop-62-draft-forge-aws-catalog-trust  #1316 forge+aws-catalog+artifact-trust
                                                               └── sdlc/anti-slop-63-draft-snapshot-k8s  #1319 snapshot-compaction+k8s-contract
                                                                └── sdlc/anti-slop-64-draft-realize-auth-projection  #1320 realize+auth-consumer+document-projection
                                                                 └── sdlc/anti-slop-65-draft-authoring-stage-ha  #1321 authoring+stage-gate+control-plane-ha
                                                                  └── sdlc/anti-slop-66-draft-broker-training-auth  #1323 meta-cloud-broker+training-engine+auth-authoring
                                                                   └── sdlc/anti-slop-67-draft-relational-registry-bindles  #1324 relational-projection+registry-ingest+bindles-freeze
                                                                    └── sdlc/anti-slop-68-draft-non-iac-mcp-componentize  #1327 non-iac-adapters+mcp-server+componentize
                                                                     └── sdlc/anti-slop-69-draft-policy-planner-adapters  #1328 built-in-policy+planner-dag+policy-adapters
                                                                      └── sdlc/anti-slop-70-draft-eval-overlay-dispatcher  #1329 eval-promotion+overlay-mesh+dispatcher-credits
                                                                       └── sdlc/anti-slop-71-draft-resource-operator-closure  #1330 resource-definition+operator-ports+closure-lowering
                                                                        └── sdlc/anti-slop-72-draft-slo-events-closure-eval  #1331 slo+events+closure-v1+live-eval
                                                                         └── sdlc/anti-slop-73-draft-vm-xaa-containment-policy  #1332 vm-microvm+inbound-xaa+containment+policy-port
                                                                          └── sdlc/anti-slop-74-draft-offline-engine-federate-acme  #1333 signed-offline+contract-engine+federate+acme
                                                                           └── sdlc/anti-slop-75-draft-connectivity-interconnect-flags  #1334 connectivity-policy+interconnect+flags+domain-validation
                                                                            └── sdlc/anti-slop-76-draft-artifact-dispatch-dagger-certify  #1335 artifact-repo+driver-dispatch+dagger+certify
                                                                             └── sdlc/anti-slop-77-draft-matching-host-projection-network  #1336 matching-engine+execution-host+projection-rebuild+tier-two
                                                                              └── sdlc/anti-slop-78-draft-local-dev-closure-agent-manifest  #1337 local-dev-authoring+closure-public-api+durable-agent+manifest
                                                                               └── sdlc/anti-slop-79-draft-protobuf-promotion-capability  #1338 protobuf-cue+observed-promotion+capability-manifest+capability-spec
                                                                                └── sdlc/anti-slop-80-draft-eventstore-ca-cost-revocation  #1339 camp-eventstore+internal-ca+cost-guard+session-revocation
                                                                                 └── sdlc/anti-slop-81-draft-wit-budget-eval-listing  #1340 wit-conformance+budget-quota+eval-methodology+listing-yank
                                                                                  └── sdlc/anti-slop-82-draft-runbook-pack-flag-identity  #1341 runbook+resource-pack+auth-flag-readset+identity-event
                                                                                   └── sdlc/anti-slop-83-draft-bind-junction-trace-flag  #1342 bind-reference+junction-federated+trace-context+feature-flag-port
                                                                                    └── sdlc/anti-slop-84-draft-rbac-broker-read-plan  #1343 rbac-resolution+broker-env+read-surface+deployment-plan-ir
                                                                                     └── sdlc/anti-slop-85-draft-core-poison-options-registry  #1344 core+poison-event+provider-options+registry-artifact
                                                                                      └── sdlc/anti-slop-86-draft-alert-wasm-connector-crew  #1345 alertmanager+build-wasm+connector-authoring+crew-event
                                                                                       └── sdlc/anti-slop-87-draft-orchestrator-saga-dns-authz  #1346 orchestrator+saga-templates+dns-rebinding+end-user-authz
                                                                                        └── sdlc/anti-slop-88-draft-lifecycle-evals-metering-openfeature  #1347 lifecycle-phase+live-evals+metering-view+openfeature
                                                                                         └── sdlc/anti-slop-89-draft-otel-remediation-escape-wasi  #1348 otel-traces+remediation-safety+repo-view-escape+wasi-pins
                                                                                          └── sdlc/anti-slop-90-draft-x509-yard-domain  #1349 x509-svid-mtls+yard-domain-validation
                                                                                           └── sdlc/anti-slop-91-draft-capability-conformance-authz-cutover  #1350 capability-negotiation+conformance-port+authz-cache+domain-cutover
                                                                                            └── sdlc/anti-slop-92-draft-drift-gateway-chaos-secret  #1351 drift-detection+gateway-realization+golden-chaos+config-secret
                                                                                             └── sdlc/anti-slop-93-draft-remediation-console-dapr-broker  #1352 remediation-action+operator-console+dapr-kafka+broker-resolution
                                                                                              └── sdlc/anti-slop-94-draft-mirror-oci-page-paradigm  #1353 mirror-digest+oci-artifact+paginated-query+paradigm-idiom
                                                                                               └── sdlc/anti-slop-95-draft-local-reactor-guardrails-signed  #1354 provider-local+reactor-fanout+agent-guardrails+signed-artifact
                                                                                                └── sdlc/anti-slop-96-draft-tier-one-rollback-wit-yard  #1355 tier-one-network+upgrade-rollback+wit-port-stub+yard-topology
                                                                                                 └── sdlc/anti-slop-97-draft-flag-chaos-tier-governance  #1356 flag-store+chaos-experiment+connectivity-tier+data-governance
                                                                                                  └── sdlc/anti-slop-98-draft-forge-search-guardrail-runtime  #1357 forge-certification+full-text-search+guardrail-gate+runtime-primitives
                                                                                                   └── sdlc/anti-slop-99-draft-opentofu-junction-queue-rbac  #1358 opentofu+junction-federation+queue-clock+rbac-binding
                                                                                                    └── sdlc/anti-slop-100-draft-registry-reconcile-rollback-runaway  #1359 registry-guard+resourceactor-reconcile+rollback-compensation+runaway-remediation
                                                                                                     └── sdlc/anti-slop-101-draft-spend-flag-secretless-escape  #1360 runaway-spend+sdk-flag+secretless-config+static-key-escape
                                                                                                      └── sdlc/anti-slop-102-draft-token-adopt-champion-host  #1361 token-broker+adopt-in-place+champion-challenger+component-host
                                                                                                       └── sdlc/anti-slop-103-draft-staleness-delta-dr-experiment  #1362 staleness+delta-set+disaster-recovery+experiment-stats
                                                                                                        └── sdlc/anti-slop-104-draft-gate-gql-catalog-jwt-login-principal-iac  #1363 gatekeeper+graphql+bindles+jwt+login+principal+crossplane+pulumi
                                                                                                         └── sdlc/anti-slop-105-draft-livefix-mcp-oidc-ops-projection-reactor  #1364 live-fix+mcp+oidc+ops+projection+reactor+ranking
                                                                                                          └── sdlc/anti-slop-106-draft-registry-runbook-pulumi-slo-sre  #1365 registry-publish+runbook+pulumi-adapter+effects+showback+slo+sre
                                                                                                           └── sdlc/anti-slop-107-draft-svid-mtls-token-topology-attest  #1366 svid-rotation+tier-five-mtls+token-exchange+topology+attestation
                                                                                                            └── sdlc/anti-slop-108-draft-capability-cost-routing-catalog  #1367 capability+cost+routing+catalog
                                                                                                             └── sdlc/anti-slop-109-draft-deploy-artifact-dns-flag-gen  #1368 deploy-view+artifact-version+dns-threat+flag-gov+remediation+gen-sanitize+promo+provider
                                                                                                              └── sdlc/anti-slop-110-draft-gen-gov-auth-dsl-dev  #1369 gen-validation+governance+auth-json+code-dsl+dev-fidelity+dev-loop+experiment+up-convergence
                                                                                                               └── sdlc/anti-slop-111-draft-incident-jwt-obligation-sandbox  #1370 incident+guardrail+junction+jwt-svid+manifest+sandbox+obligation+openexperiment
                                                                                                                └── sdlc/anti-slop-112-draft-policy-registry-runtime-telemetry  #1371 policy-flag+portability+provider-defaults+registry-import+sla+runtime-port+search+sre-diagnose+logs+telemetry+yard-receipt
                                                                                                                 └── sdlc/anti-slop-113-draft-opto-client-cost-flag-event  #1372 opto-training+optimistic-update+cost-signal+flag-consistency+deny-ceiling+event-body+dr-failover+evals-gates
                                                                                                                  └── sdlc/anti-slop-114-draft-upcaster-gen-dns-doctor-jag  #1373 upcaster+repair-loop+llm-fill+safety-gate+dns+doctor+human-approval+id-jag
                                                                                                                   └── sdlc/anti-slop-115-draft-junction-matching-mtls-policy  #1374 junction-plan+matching+mtls-default+mtls-path+offline-import+trajectory+waiver+fail-closed
                                                                                                                    └── sdlc/anti-slop-116-draft-host-sdk-cost-replay-wrpc  #1375 local-host+sdk-codegen+shared-cost+failure-classifier+token-replay+topology-override+trust-tier+wrpc-link
                                                                                                                     └── sdlc/anti-slop-117-draft-preview-drift-receipt-host-broker  #1376 preview+drift-remediation+receipt+host-conformance+connector-broker+policy-bypass+credit-ledger+error-budget
                                                                                                                      └── sdlc/anti-slop-118-draft-genio-install-logs-iac-ocsf  #1377 gen-pipeline-io+add-install+logs-cli+iac-state+ocsf-export+materialization+metrics-catalog+on-call
                                                                                                                       └── sdlc/anti-slop-119-draft-xaa-persona-fly-vercel-reads  #1378 outbound-xaa+persona+platform-flow+fly+vercel+reads-your-writes+run-inspector+yard-shell
                                                                                                                        └── sdlc/anti-slop-120-draft-mcp-bootstrap-slo-slsa-snapshot  #1379 mcp-poc+bootstrap-saga+slo-promotion+slo-rollback+slsa+snapshot-replay+split-horizon+sre-operator
                                                                                                                         └── sdlc/anti-slop-121-draft-streamer-stub-svid-wrpc  #1380 streamer-runtime+stub-generation+stuck-rollout+svid-partition+token-broker-ha+usage-permissions+vscode+websocket-fanout+wire-version+wrpc-lattice+wrpc-membrane
                                                                                                                          └── sdlc/anti-slop-122-draft-exp-cx-ux-4count  #1381 launch-posture+compat-matrix+onboarding-script+launch-blocker+workspace-telemetry+svid-guard+vibe-walkthroughs
                                                                                                                           └── sdlc/anti-slop-123-draft-exp-tinies  #1382 80 remaining 1-3 count exp-proofs
                                                                                                                            └── sdlc/anti-slop-124-draft-exp-5count  #1383 xaa-scope+sre-drift+vibe-dashboard+pilot+snapshop+support
                                                                                                                             └── sdlc/anti-slop-125-draft-exp-6count  #1384 billing-credits+legal-privacy-beta/rc+dogfood-yard-rc+readiness-dashboard+vibe-publisher/support
                                                                                                                              └── sdlc/anti-slop-126-draft-exp-7count  #1385 cli-mcp-parity+hosted-broker-ga+backup-restore-drill+cli-deploy+vibe-a11y+vibe-tutorials
                                                                                                                               └── sdlc/anti-slop-127-draft-exp-8count-cx  #1386 beta-pilot-ga/rc+known-limitations+launch-site-demo/ga+launch-support-rc+legal-privacy-ga+release-notes-ga
                                                                                                                                └── sdlc/anti-slop-128-draft-exp-8count-rest  #1387 release-notes-rc+chaos-resilience+dogfood-yard-ga/m1+launch-performance+vibe-a11y-checklist+launch-asset
                                                                                                                                 └── sdlc/anti-slop-129-draft-exp-9-11count  #1388 broker-rejection+harness-experience+launch-site-rc+role-action-matrix+tenant-routing+policy-audit+cli-cloud-yard+docs-portal
                                                                                                                                  └── sdlc/anti-slop-130-draft-exp-13-17count  #1389 bootstrap-smoke+admin-console+launch-support-ga+support-debug+cli-manage+audit-explorer+plan-annotation+troubleshooting+fixture-corpus
                                                                                                                                   └── sdlc/anti-slop-131-draft-exp-19-25count  #1390 sdk-to-cli+scenario-matrix+full-dashboard+freshness-rbac+refusal-envelopes+plan-diff+topology-status+private-beta-notes
                                                                                                                                    └── sdlc/anti-slop-132-draft-exp-28-33count  #1391 marketplace-discovery+workspace-states+sdk-object-graph+role-journey+cli-refusal+dx-backbone+quickstart-examples+first-run-rail
                                                                                                                                     └── sdlc/anti-slop-133-draft-exp-highcount  #1392 convex-swaghaus-bindle+marketplace-trust-copy+control-plane-api-lifecycle
                                                                                                                                      └── sdlc/anti-slop-134-draft-projects-small  #1393 finops-plane+otel-office+hobo-build+provider-cloudflare
                                                                                                                                       └── sdlc/anti-slop-135-draft-projects-identity  #1394 s3-02-hobo-identity
                                                                                                                                        └── sdlc/anti-slop-136-draft-projects-conformance-sdk  #1395 s1-24-conformance-sdk
                                                                                                                                         └── sdlc/anti-slop-137-draft-projects-hobo-core  #1396 s0-03-hobo-core
                                                                                                                                          └── sdlc/anti-slop-138-packages-tinies  #1397 schema-tools+componentize+claims+convex+junctions
                                                                                                                                           └── sdlc/anti-slop-139-packages-rift-registry  #1398 rift+registry+training+kv-redis
                                                                                                                                            └── sdlc/anti-slop-140-packages-pixel-village  #1401 pixel-village
                                                                                                                                             └── sdlc/anti-slop-141-packages-cloud  #1403 packages/cloud
                                                                                                                                              └── sdlc/anti-slop-142-packages-cli  #1405 packages/cli
                                                                                                                                               └── sdlc/anti-slop-143-packages-iac  #1407 iac-pulumi+terraform+crossplane
                                                                                                                                                └── sdlc/anti-slop-144-packages-packs  pack-framework+valkey+postgres
                                                                                                                                                 └── sdlc/anti-slop-145-packages-yards  packages/yards
```

Full-repo `pnpm run lint:slop` stays opt-in (large backlog). Pre-commit and
`agent:check` run `lint:slop:changed` on touched TS/JS with `--deny-warnings`.
Skill-tree edits now also select `skills:mirror-check`.

## Next slices (file-complete, not warning-only)

The changed-file gate lints the **whole file**. A warning-only pass over
`scripts/` fails because those files still carry anti-slop errors. Current
`scripts/` count: 127 errors / 16 warnings (57 files). Highest error counts:

- `require-safety-comment-for-type-assertion`
- `no-runtime-typeof`
- `no-known-value-widening`
- `no-unsafe-dictionary-type`

Each follow-up PR should take **one file (or a tight cluster) to zero
findings**, then stop. Do not edit a file that still has other anti-slop
errors.

Cleared: entire `scripts/` tree (layer 3). Layer 4: root competitor/council tests.
Layer 5: `examples/` oxlint-clean (named JsonValue parse boundaries,
UsageReader returns, Firecrawl client injection instead of `vi.mock`).
Layer 6: `site/` oxlint-clean (`site/src/lib/json-inspect.ts`).
Layer 7–10: connectors, data, recipes, mcp.
Layer 11: smallest provider packages (config, agentv, cedar, opa, ax,
blacksmith).
Layer 12: runner-depot + provider-flux.
Layer 13: runner-github + provider-lakebed.
Layer 14: provider-railway + provider-convex.
Layer 15: provider-webernetes + provider-kafka + provider-ttl-sh.
Layer 16: provider-neon + provider-prisma-postgres.
Layer 17: provider-browser-wasm.
Layer 18: provider-upstash.
Layer 19: provider-netlify.
Layer 20: provider-vercel.
Layer 21: provider-hostinger (#1216).
Layer 22: provider-hetzner (#1218).
Layer 23: provider-aws (#1220).
Layer 24: provider-gcp (#1222).
Layer 25: provider-azure (#1224).
Layer 26: provider-cloudflare (#1231).
Layer 27: provider-digitalocean (#1235).
Layer 28: `@hobo/code` oxlint `--deny-warnings` and `tsc --noEmit` clean (#1238).
Layer 29: `@hobo/hobo` oxlint `--deny-warnings` and `tsc --noEmit` clean (#1241).
Layer 30: `@hobo/core` oxlint `--deny-warnings` and `tsc --noEmit` clean (#1242).
Layer 31: `@hobo/broker` oxlint `--deny-warnings` and `tsc --noEmit` clean (#1243).
Layer 32: `@hobo/connectivity` oxlint `--deny-warnings` and `tsc --noEmit` clean (#1244).
Layer 33: `@hobo/bindles` oxlint `--deny-warnings` and `tsc --noEmit` clean (#1245).
Layer 34: `@hobo/contracts` oxlint `--deny-warnings` and `tsc --noEmit` clean (#1249).
Layer 35: `@hobo/stations` oxlint `--deny-warnings` and `tsc --noEmit` clean (#1251).
Layer 36: `@hobo/storage-sqlite` oxlint `--deny-warnings` and `tsc --noEmit` clean (#1254).
Layer 37: `@hobo/policy` oxlint `--deny-warnings` and `tsc --noEmit` clean (#1256).
Layer 38: `@hobo/dispatcher` oxlint `--deny-warnings` and `tsc --noEmit` clean (#1258).
Layer 39: `@hobo/runtime-wasm` + `@hobo/runtime-celld` + `@hobo/runtime-cloud-native`
oxlint `--deny-warnings` and `tsc --noEmit` clean (#1261).
Layer 40: `@hobo/runtime-browser` + `@hobo/runtime-oci` oxlint `--deny-warnings`
and `tsc --noEmit` clean (#1263).
Layer 41: `@hobo/runtime-dapr` + `@hobo/runtime-rivet` oxlint `--deny-warnings`
and `tsc --noEmit` clean (#1266).
Layer 42: `@hobo/runtime-local` oxlint `--deny-warnings` and `tsc --noEmit` clean (#1274).
Layer 43: `@hobo/runtime` + `@hobo/conformance` oxlint `--deny-warnings` and `tsc --noEmit` clean (#1276).
Layer 44: `@hobo/identity` oxlint `--deny-warnings` and `tsc --noEmit` clean (#1278).
Layer 45: remaining `@hobo/adapter-*` (drizzle, better-auth, openbao, hono) oxlint `--deny-warnings` and `tsc --noEmit` clean (#1280).
Layer 46: `@hobo/provider-kubernetes` oxlint `--deny-warnings` and `tsc --noEmit` clean (#1284).
Layer 47: `src/draft/epic-proofs` oxlint `--deny-warnings` clean (#1286).
Layer 48: 122 tiny `src/draft/technical-proofs` packages (1–3 findings) oxlint `--deny-warnings` clean (#1289).
Layer 49: `pact-contract-harness` + `deterministic-replay-engine` + `hobo-policy-ir-contract` oxlint `--deny-warnings` clean (#1291).
Layer 50: `ifc-handler-trigger-hobo-608` + `s1-19-ctx-config-local-resolution` + `membrane-deadline-backpressure-contract` oxlint `--deny-warnings` clean (#1294).
Layer 51: `s1-15-bind-wiring-topology-contract` oxlint `--deny-warnings` clean (#1296).
Layer 52: `hobo-runtime-ts-primitives` + `multi-region-dr-replay-contract` oxlint `--deny-warnings` clean (#1297).
Layer 53: `raw-driver-escape-hatch-contract` + `hobo-contract-ir` + `runtime-postgres-ports` oxlint `--deny-warnings` clean (#1299).
Layer 54: `provider-cloudflare-contract` + `camp-mapping-sugar-compiler` oxlint `--deny-warnings` clean (#1301).
Layer 55: `resource-collection-engine-contract` + `s4-03-provider-azure-full-capability-manifest` oxlint `--deny-warnings` clean (#1303).
Layer 56: `ifc-handler-trigger-contract` + `actor-host-runtime-port-contract` + `data-paradigm-authoring-contract` oxlint `--deny-warnings` clean (#1305).
Layer 57: `s4-08-portability-conformance-lane-contract` + `s1-17-usage-permissions-coverage-poc` + `convex-swaghaus-deploy-adapter` oxlint `--deny-warnings` clean (#1307).
Layer 58: `s2-04-planner-deployment-plan-dag-poc` + `hobo-612-dev-local-loop-poc` + `closure-builder-resource-handles-contract` oxlint `--deny-warnings` clean (#1309).
Layer 59: `provider-azure-contract` + `provider-gcp-contract` + `provider-aws-contract` oxlint `--deny-warnings` clean (#1311).
Layer 60: `iac-cdktf-import-only-contract` + `cqrs-command-aggregate-contract` + `native-log-projection-contract` oxlint `--deny-warnings` clean (#1313).
Layer 61: `container-fallback-wiring-parity-contract` + `wrpc-link-layer-contract` + `s6-05-observability-drift-loop-contract` oxlint `--deny-warnings` clean (#1315).
Layer 62: `s5-03-forge-ingestion-contract` + `provider-aws-full-capability-catalog-contract` + `componentize-artifact-trust-contract` oxlint `--deny-warnings` clean (#1316).
Layer 63: `snapshot-compaction-contract` + `provider-kubernetes-contract` oxlint `--deny-warnings` clean (#1319).
Layer 64: `hobo-realize-emission-contract` + `hobo-auth-consumer-contract` + `document-projection-sink-contract` oxlint `--deny-warnings` clean (#1320).
Layer 65: `provider-authoring-contract` + `s1-stage-gate` + `s6-02-control-plane-ha-contract` oxlint `--deny-warnings` clean (#1321).
Layer 66: `meta-cloud-broker-artifact-contract` + `training-engine-port-contract` + `hobo-auth-authoring-surface` oxlint `--deny-warnings` clean (#1323).
Layer 67: `relational-projection-sink-contract` + `registry-capability-manifest-ingest-contract` + `bindles-api-freeze-contract` oxlint `--deny-warnings` clean (#1324).
Layer 68: `non-iac-driver-adapters-contract` + `hobo-mcp-server-contract` + `hobo-componentize` oxlint `--deny-warnings` clean (#1327).
Layer 69: `built-in-policy-engine-contract` + `planner-dag-skeleton-contract` + `policy-engine-provider-adapters-contract` oxlint `--deny-warnings` clean (#1328).
Layer 70: `eval-promotion-gate-contract` + `tier-four-overlay-mesh-contract` + `dispatcher-maximize-credits-contract` oxlint `--deny-warnings` clean (#1329).
Layer 71: `resource-definition-driver-contract` + `operator-integration-ports-contract` + `closure-builder-manifest-lowering-contract` oxlint `--deny-warnings` clean (#1330).
Layer 72: `slo-as-code-contract` + `control-plane-event-schema-contract` + `closure-builder-v1-finalization-contract` + `openinference-live-eval-stream-contract` oxlint `--deny-warnings` clean (#1331).
Layer 73: `vm-microvm-build-providers-contract` + `inbound-xaa-resource-server-contract` + `malicious-provider-containment-contract` + `policy-engine-port-contract` oxlint `--deny-warnings` clean (#1332).
Layer 74: `signed-offline-bundle-contract` + `contract-engine-port-contract` + `hobo-auth-federate-verify-contract` + `acme-dns01-cert-issuance-contract` oxlint `--deny-warnings` clean (#1333).
Layer 75: `connectivity-policy-enforcement-contract` + `tier-three-private-interconnect-contract` + `flag-event-contract` + `domain-validation-gate-contract` oxlint `--deny-warnings` clean (#1334).
Layer 76: `artifact-repo-port-contract` + `driver-dispatch-routing-contract` + `build-dagger-provider-contract` + `generation-certify-stage-contract` oxlint `--deny-warnings` clean (#1335).
Layer 77: `matching-engine-skeleton-contract` + `execution-host-provider-contract` + `projection-rebuild-contract` + `tier-two-cross-region-network-contract` oxlint `--deny-warnings` clean (#1336).
Layer 78: `local-dev-test-authoring-contract` + `closure-builder-public-api-contract` + `durable-agent-primitive-contract` + `hobo-manifest-contract` oxlint `--deny-warnings` clean (#1337).
Layer 79: `s0-04-protobuf-cue-codegen` + `observed-contract-promotion-contract` + `provider-capability-manifest-contract` + `capability-spec-contract` oxlint `--deny-warnings` clean (#1338).
Layer 80: `camp-eventstore-runtime-port-contract` + `internal-ca-private-acme-contract` + `observability-cost-guard-contract` + `session-revocation-contract` oxlint `--deny-warnings` clean (#1339).
Layer 81: `s5-02-wit-interface-conformance-coverage` + `budget-quota-policy-contract` + `generation-eval-methodology-spike` + `listing-lifecycle-yank-contract` oxlint `--deny-warnings` clean (#1340).
Layer 82: `runbook-contract` + `resource-pack-distribution-contract` + `auth-flag-readset-contract` + `identity-event-contract` oxlint `--deny-warnings` clean (#1341).
Layer 83: `bind-reference-wiring-contract` + `junction-federated-domain-contract` + `trace-context-propagation-contract` + `hobo-feature-flag-port` oxlint `--deny-warnings` clean (#1342).
Layer 84: `auth-port-rbac-resolution-contract` + `broker-environment-publication-contract` + `default-read-surface-contract` + `deployment-plan-ir-contract` oxlint `--deny-warnings` clean (#1343).
Layer 85: `hobo-core-contract` + `poison-event-quarantine-contract` + `provider-options-pattern-contract` + `registry-artifact-descriptor-contract` oxlint `--deny-warnings` clean (#1344).
Layer 86: `alertmanager-routing-contract` + `build-wasm-provider-contract` + `connector-authoring-contract` + `crew-event-contract` oxlint `--deny-warnings` clean (#1345).
Layer 87: `delivery-orchestrator-skeleton-contract` + `deployment-strategy-saga-templates-contract` + `dns-validation-rebinding-guard-contract` + `end-user-authorization-policy-contract` oxlint `--deny-warnings` clean (#1346).
Layer 88: `lifecycle-phase-policy-contract` + `live-evals-runtime-contract` + `metering-view-projection-contract` + `openfeature-provider-adapters-contract` oxlint `--deny-warnings` clean (#1347).
Layer 89: `otel-traces-pipeline-contract` + `remediation-safety-gate-contract` + `repo-view-escape-hatches-contract` + `wasi-interface-pins` oxlint `--deny-warnings` clean (#1348).
Layer 90: `x509-svid-mtls-contract` + `yard-domain-validation-contract` oxlint `--deny-warnings` clean (#1349).
Layer 91: `capability-negotiation-contract` + `conformance-port-suite-contract` + `control-plane-authz-cache-contract` + `domain-cutover-saga-contract` oxlint `--deny-warnings` clean (#1350).
Layer 92: `drift-detection-loop-contract` + `gateway-realization-contract` + `golden-suite-chaos-verification-contract` + `hobo-config-secret-schema-contract` oxlint `--deny-warnings` clean (#1351).
Layer 93: `hobo-remediation-action-contract` + `human-operator-console-contract` + `messaging-dapr-kafka` + `meta-cloud-broker-resolution-contract` oxlint `--deny-warnings` clean (#1352).
Layer 94: `mirror-digest-selection-contract` + `oci-artifact-storage-contract` + `paginated-query-contract` + `paradigm-idiom-packages-contract` oxlint `--deny-warnings` clean (#1353).
Layer 95: `provider-local-zero-infra` + `reactor-coalescing-fanout-contract` + `s3-07-agent-guardrails-contract` + `signed-artifact-publish-install-contract` oxlint `--deny-warnings` clean (#1354).
Layer 96: `tier-one-private-network-contract` + `upgrade-rollback-dry-run-contract` + `wit-port-stub-contract` + `yard-topology-manifest-contract` oxlint `--deny-warnings` clean (#1355).
Layer 97: `built-in-flag-store-contract` + `chaos-experiment-orchestration-contract` + `connectivity-tier-ir-contract` + `data-governance-policy-contract` oxlint `--deny-warnings` clean (#1356).
Layer 98: `forge-certification-loop-contract` + `full-text-search-contract` + `guardrail-policy-gate-contract` + `hobo-runtime-primitives` oxlint `--deny-warnings` clean (#1357).
Layer 99: `iac-opentofu-backend-contract` + `junction-registry-federation-contract` + `queue-clock-runtime-port-contract` + `rbac-role-binding-contract` oxlint `--deny-warnings` clean (#1358).
Layer 100: `registry-dependency-confusion-guard-contract` + `resourceactor-reconcile-loop-contract` + `rollback-failure-compensation-contract` + `runaway-remediation-guard-contract` oxlint `--deny-warnings` clean (#1359).
Layer 101: `runaway-spend-circuit-breaker-contract` + `sdk-flag-surface-contract` + `secretless-config-resolution-contract` + `static-key-escape-hatch-contract` oxlint `--deny-warnings` clean (#1360).
Layer 102: `token-broker-skeleton-contract` + `adopt-in-place-contract` + `champion-challenger-promotion-contract` + `component-host-adapter-certification-spike` oxlint `--deny-warnings` clean (#1361).
Layer 103: `cross-camp-bounded-staleness-contract` + `delta-set-apply-reconcile-contract` + `disaster-recovery-failover-contract` + `experiment-statistical-analysis-contract` oxlint `--deny-warnings` clean (#1362).
Layer 104: `gatekeeper-verify-contract` + `graphql-facade-runtime-contract` + `hobo-bindles-resource-catalog` + `hobo-jwt-svid-contract` + `hobo-login-claim-contract` + `hobo-principal-ref-contract` + `iac-crossplane-backend-contract` + `iac-pulumi-backend-contract` oxlint `--deny-warnings` clean (#1363).
Layer 105: `live-fix-gated-candidate-contract` + `mcp-server-hardening-contract` + `oidc-federation-sts-contract` + `operations-manifests-contract` + `projection-consistency-reactivity-contract` + `projection-sink-change-feed-conformance-contract` + `reactor-skeleton-contract` + `region-objective-ranking-contract` oxlint `--deny-warnings` clean (#1364).
Layer 106: `registry-publish-flow-contract` + `runbook-execution-engine-contract` + `s2-06-iac-pulumi-automation-adapter` + `s3-05-allow-triple-effects-poc` + `showback-attribution-contract` + `slo-gaming-guard-contract` + `slo-gated-rollback-analysis-contract` + `sre-mttd-mttr-postmortem-contract` oxlint `--deny-warnings` clean (#1365).
Layer 107: `svid-auto-rotation-contract` + `tier-five-public-mtls-contract` + `token-broker-exchange-contract` + `topology-objects-contract` + `workload-attestation-intake-contract` oxlint `--deny-warnings` clean (#1366). 7-count technical-proofs are cleared.
Layer 108: `capability-enforcement-contract` + `capability-indexed-discovery-contract` + `connectivity-cost-feedback-contract` + `control-plane-action-taxonomy-contract` + `cost-degradation-saga-contract` + `cross-camp-routing-policy-contract` + `cross-layer-generated-stack-propagation-contract` + `curated-catalog-policy-contract` oxlint `--deny-warnings` clean (#1367).
Layer 109: `deployment-view-saga-graph-contract` + `distributed-artifact-version-policy` + `dns-validation-gate-threat-model` + `feature-flag-governance-contract` + `gated-autonomous-remediation-contract` + `generation-material-sanitization-contract` + `generation-promotion-policy-gate-contract` + `generation-provider-loop-contract` oxlint `--deny-warnings` clean (#1368).
Layer 110: `generation-validation-stage-contract` + `governance-conformance-suite-contract` + `hobo-auth-json-contract` + `hobo-code-dsl-contract` + `hobo-dev-fidelity-drift-contract` + `hobo-dev-loop-contract` + `hobo-experiment-port` + `hobo-up-convergence-contract` oxlint `--deny-warnings` clean (#1369).
Layer 111: `incident-aggregate-contract` + `issue-worker-guardrail-mapping-contract` + `junction-connectivity-inference-spike` + `jwt-svid-issuance-contract` + `manifest-resource-intent-bridge-contract` + `no-egress-generation-sandbox-contract` + `obligation-engine-contract` + `openexperiment-runtime-data-contract` oxlint `--deny-warnings` clean (#1370).
Layer 112: `policy-gated-flag-flips-contract` + `portability-swap-equivalent-contract` + `provider-default-definitions-contract` + `registry-import-contract` + `reliability-sla-rollup-contract` + `runtime-port-conformance-contract` + `search-extension-packages-contract` + `sre-diagnose-projection-contract` + `structured-log-pipeline-contract` + `telemetry-envelope-contract` + `yard-receipt-consumption-contract` oxlint `--deny-warnings` clean (#1371). 6-count technical-proofs are cleared.
Layer 113: `built-in-opto-training-engine-contract` + `client-optimistic-update-contract` + `cost-signal-contract` + `cross-camp-flag-state-consistency-contract` + `deny-ceiling-algebra-poc` + `domain-event-body-contract` + `dr-failover-integrity-contract` + `evals-training-promotion-gates-poc` oxlint `--deny-warnings` clean (#1372).
Layer 114: `event-body-upcaster-gate` + `generation-bounded-repair-loop-contract` + `generation-llm-fill-contract` + `generation-safety-gate-contract` + `hobo-dns-port-contract` + `hobo-doctor-contract` + `human-approval-generation-gate-contract` + `id-jag-token-exchange-contract` oxlint `--deny-warnings` clean (#1373).
Layer 115: `junction-connectivity-plan-contract` + `matching-specificity-vectors` + `mtls-by-default-conformance-gate` + `mtls-data-path-contract` + `offline-import-integrity-contract` + `openinference-trajectory-capture-contract` + `policy-authoring-waiver-contract` + `policy-fail-closed-contract` oxlint `--deny-warnings` clean (#1374).
Layer 116: `runtime-local-component-host` + `sdk-codegen-surface-contract` + `shared-cost-attribution-contract` + `system-failure-classifier-contract` + `token-replay-resistance-contract` + `topology-override-conflict-contract` + `trust-tier-policy-contract` + `wrpc-in-process-link-contract` oxlint `--deny-warnings` clean (#1375). 5-count technical-proofs are cleared.
Layer 117: `anonymous-preview-path-contract` + `autonomous-drift-remediation-contract` + `broker-receipt-integrity-contract` + `component-host-conformance-suite` + `connector-runtime-broker-contract` + `control-plane-policy-bypass-guard` + `credit-ledger-view-contract` + `error-budget-deploy-gate-contract` oxlint `--deny-warnings` clean (#1376).
Layer 118: `generation-pipeline-io-contract` + `hobo-add-install-verification-contract` + `hobo-logs-cli-contract` + `iac-state-model-contract` + `identity-ocsf-export-contract` + `materialization-subscription-contract` + `metrics-catalog-pipeline-contract` + `on-call-escalation-contract` oxlint `--deny-warnings` clean (#1377).
Layer 119: `outbound-xaa-token-exchange-contract` + `persona-operating-profile-contract` + `platform-engineer-flow-contract` + `provider-fly-contract` + `provider-vercel-contract` + `reads-your-writes-contract` + `run-inspector-projection-contract` + `s2-03-cloud-yard-shell-hobo-618` oxlint `--deny-warnings` clean (#1378).
Layer 120: `s3-08-hobo-mcp-server-poc` + `self-host-bootstrap-saga-contract` + `slo-promotion-gate-contract` + `slo-rollback-decision-correctness-spike` + `slsa-provenance-certification-contract` + `snapshot-replay-divergence-contract` + `split-horizon-partition-connectivity-contract` + `sre-operator-skeleton-contract` oxlint `--deny-warnings` clean (#1379).
Layer 121: `streamer-runtime-port-contract` + `stub-implementation-generation-contract` + `stuck-rollout-convergence-contract` + `svid-partition-grace-spike` + `token-broker-ha-cache-contract` + `usage-inferred-permissions-contract` + `vscode-extension-contract` + `websocket-streamer-fanout-contract` + `wire-version-negotiation-contract` + `wrpc-lattice-transport-contract` + `wrpc-membrane-failure-contract` oxlint `--deny-warnings` clean (#1380). Restores `classifyFailure` parse of Error instances so membrane subclasses keep partial-failure. 4-count technical-proofs are cleared.
Layer 122: `ai-generation-launch-posture-contract` + `compatibility-matrix-scope-contract` + `customer-onboarding-script-contract` + `launch-blocker-taxonomy-contract` + `workspace-activation-telemetry-contract` + `svid-cross-tenant-guard-contract` + `vibe-clickable-first-run-walkthrough` + `vibe-marketplace-installability-mockups` + `vibe-pilot-first-proof-walkthrough` + `vibe-plan-review-states` oxlint `--deny-warnings` clean (#1381). 4-count exp-proofs are cleared.
Layer 123: 80 remaining 1–3 count `src/draft/exp-proofs` packages oxlint `--deny-warnings` clean (#1382).
Layer 124: `xaa-scope-inference-contract` + `sre-drift-remediation-journey-contract` + `vibe-deployment-dashboard-mockups` + `vibe-first-customer-pilot-storyboard` + `vibe-snapshop-launch-demo-storyboard` + `vibe-support-case-redacted-evidence` oxlint `--deny-warnings` clean (#1383). 5-count exp-proofs are cleared.
Layer 125: `billing-credits-scope-contract` + `legal-privacy-private-beta-evidence-contract` + `legal-privacy-release-candidate-evidence-contract` + `dogfood-yard-release-candidate-contract` + `v1-readiness-dashboard-contract` + `vibe-publisher-portal-review-mockups` + `vibe-support-workflow-mockups` oxlint `--deny-warnings` clean (#1384). 6-count exp-proofs are cleared.
Layer 126: `cli-mcp-parity-resource-lifecycle-contracts` + `hosted-broker-ga-handoff-evidence-contract` + `backup-restore-launch-drill-contract` + `cli-deploy-transcript-prototype` + `vibe-representative-a11y-usability-checks` + `vibe-role-tutorial-outlines` oxlint `--deny-warnings` clean (#1385). 7-count exp-proofs are cleared.
Layer 127: `beta-pilot-ga-handoff-evidence-contract` + `beta-pilot-release-candidate-evidence-contract` + `known-limitations-register-contract` + `launch-site-demo-alpha-evidence-contract` + `launch-site-ga-handoff-evidence-contract` + `launch-support-release-candidate-evidence-contract` + `legal-privacy-ga-handoff-evidence-contract` + `v1-release-notes-upgrade-guide-ga-handoff-evidence-contract` oxlint `--deny-warnings` clean (#1386).
Layer 128: `v1-release-notes-upgrade-guide-release-candidate-evidence-contract` + `chaos-resilience-tests-scope-acceptance` + `dogfood-yard-ga-handoff-evidence-contract` + `dogfood-yard-m1-evidence-contract` + `launch-performance-capacity-envelope-contract` + `vibe-accessibility-usability-checklist` + `vibe-launch-asset-refresh-plan` oxlint `--deny-warnings` clean (#1387). 8-count exp-proofs are cleared.
Layer 129: `meta-cloud-broker-rejection-matrix-contract` + `hobo-code-harness-experience` + `launch-site-release-candidate-evidence-contract` + `default-role-action-matrix-contract` + `per-app-tenant-routing-contract` + `policy-audit-export-contract` + `cli-cloud-yard-path` + `vibe-docs-portal-ia-states` oxlint `--deny-warnings` clean (#1388). Remaining 9–11 count exp-proofs are cleared.
Layer 130: `bootstrap-launch-smoke-matrix-contract` + `admin-console-scope` + `launch-support-ga-handoff-evidence-contract` + `support-debug-tools-scope-contract` + `cli-manage-inspect-logs-drift-prototype` + `audit-explorer-scope-contract` + `vibe-plan-annotation-pseudocode` + `vibe-troubleshooting-decision-trees` + `dx-resource-lifecycle-fixture-corpus` oxlint `--deny-warnings` clean (#1389). Remaining 13–17 count exp-proofs are cleared.
Layer 131: `sdk-to-cli-golden-path` + `dx-resource-lifecycle-scenario-matrix` + `full-dashboard-projection-views-contract` + `vibe-dashboard-freshness-rbac-fixtures` + `dx-result-refusal-proof-envelopes` + `vibe-plan-diff-review-prototype` + `vibe-topology-status-prototype` + `v1-release-notes-private-beta-evidence-contract` oxlint `--deny-warnings` clean (#1390). Remaining 19–25 count exp-proofs are cleared.
Layer 132: `vibe-marketplace-discovery-prototype` + `vibe-workspace-project-states` + `sdk-object-graph-manifest-ir-shapes` + `role-journey-cli-mcp-transcripts` + `cli-error-refusal-examples` + `dx-backbone-resource-lifecycle-vibe` + `resource-lifecycle-quickstart-examples` + `vibe-first-run-activation-rail` oxlint `--deny-warnings` clean (#1391). Remaining 28–33 count exp-proofs are cleared.
Layer 133: `convex-swaghaus-bindle` + `vibe-marketplace-trust-copy-states` + `control-plane-api-resource-lifecycle-shapes` oxlint `--deny-warnings` clean (#1392). Remaining 36–92 count exp-proofs are cleared. `src/draft/exp-proofs` is oxlint-clean.
Layer 134: `s6-06-finops-plane` + `otel-office` + `s1-23-hobo-build` + `s2-08-provider-cloudflare` oxlint `--deny-warnings` clean (#1393).
Layer 135: `s3-02-hobo-identity` oxlint `--deny-warnings` clean (#1394).
Layer 136: `s1-24-conformance-sdk` oxlint `--deny-warnings` clean (#1395).
Layer 137: `s0-03-hobo-core` oxlint `--deny-warnings` clean (#1396). Remaining `src/draft/projects` are oxlint-clean.
Layer 138: `schema-tools` + `componentize` + `claims` + `convex` + `junctions` plus cucumber steps, media, vitest coverage config, and the HOBO-50 projection-model proof oxlint `--deny-warnings` clean (#1397).
Layer 139: `rift` + `registry` + `training` + `kv-redis-compatible` oxlint `--deny-warnings` clean (#1398).
Layer 140: `pixel-village` oxlint `--deny-warnings` clean (#1401).
Layer 141: `packages/cloud` oxlint `--deny-warnings` clean (#1403).
Layer 142: `packages/cli` oxlint `--deny-warnings` clean (#1405).
Layer 143: `iac-pulumi` + `iac-terraform` + `iac-crossplane` oxlint `--deny-warnings` clean (#1407).
Layer 144: `pack-framework` + `pack-valkey-oci` + `pack-postgres-oci` oxlint `--deny-warnings` clean.
Layer 145: `packages/yards` oxlint `--deny-warnings` clean (0/0 on 14 files), `tsc --noEmit` clean, 129/129 tests.

Completion audit: the current source tree is anti-slop clean under the full root scan (6,636 files, zero diagnostics). The remaining package spot checks are also green: camps (7 files, 280 tests), replay (11 files, 210 tests), and yards (6 files, 129 tests). The prior camps typecheck blocker and “full-repo lint still red” note were stale branch-state observations and no longer apply.

GitHub delivery is complete through layer 145; all anti-slop pull requests are squash-merged and no open anti-slop pull requests remain.
