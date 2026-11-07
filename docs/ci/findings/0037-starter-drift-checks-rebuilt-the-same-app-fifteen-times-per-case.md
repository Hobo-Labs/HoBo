---
type: CI Performance Finding
title: "Finding 37: starter drift checks rebuilt the same app fifteen times per case"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 37: starter drift checks rebuilt the same app fifteen times per case

Merge-queue run **41849283419** timed out `regenerates starter api without deleting its runnable seed` at its unchanged **30 s** limit. The timeout was real work amplified by load, not a stalled subprocess. `hobo new app` only writes catalog files: it does not install dependencies, typecheck, initialize git, or walk the repository. An instrumented idle API run took **25.3 ms** to scaffold and **7.55 s** in its five `runCodegen` calls (1.93 s for the first write, then 1.32–1.54 s for check, drift check, repair, and custom metadata). Every generation creates one source-analysis TypeScript program and two declaration-emission programs, so each starter case built **15 programs** over unchanged source.

The fix attacks both repeated layers without changing production output. `overlayCompilerHost` now shares TypeScript's public `DocumentRegistry` for default-library syntax trees, keyed by compiler options and a content digest. Authored files and source overlays stay fresh, and an explicit new-document request still bypasses reuse. A focused unit test proves both default-library identity reuse and changed-overlay freshness. Sharing libraries alone brought the API case only to **6.11 s**, so the starter tree test now also injects the existing engine seam to reuse the first generated artifact set for its later tree operations. It still selects the real engine on every call and filters artifacts to that selection's owned roots; custom metadata therefore leaves the no-longer-owned seed untouched. All five real `runCodegen` write/check/drift operations and every original assertion remain, but full declaration generation runs once per starter rather than five times.

The CLI Vitest config also applies Finding 7's TypeScript externalization rule. Its separate config had been transforming the compiler and emitting the same missing-source-map warnings already fixed at root and on the site. This is startup work, not the per-case compile cost above.

Three isolated idle runs before and after produced these medians (the timeout remains **30,000 ms**):

| Measurement | Before | After |
|---|---:|---:|
| Whole `codegen-app-compilation.test.ts` file | 33.388 s | **9.394 s** |
| `todo` starter | 7.344 s | **1.489 s** |
| `api` starter | 7.258 s | **1.421 s** |
| `agent` starter | 7.155 s | **1.344 s** |
| `fullstack` starter | 7.035 s | **1.254 s** |

With six `(while :; do :; done) &` CPU hogs, killed by PID afterward, the whole after file took **20.503 s** of test time and the four starter cases took **3.132 / 2.738 / 2.780 / 2.674 s**. Thus the formerly marginal API case retains roughly an order of magnitude of timeout headroom under the reproduced load rather than about 4× idle headroom.

The full local baseline passed **540/540 tests in 39 files**, with **258.27 s** suite wall time and **189.07 s** accumulated per-file test time. The after package build and full suite passed **541/541 tests in 40 files** in **191.05 s**, reporting **153.43 s** test time and **33.89 s** import time. The baseline top-ten files were then rerun together for a like-for-like after sample; ordinary run-to-run noise remains visible, and the two largest compiler suites do not show a claimed improvement:

| CLI test file | Before | After |
|---|---:|---:|
| `typescript-app-build.test.ts` | 63.981 s | 69.437 s |
| `typescript-project-codegen.test.ts` | 51.216 s | 51.382 s |
| `codegen-app-compilation.test.ts` | 33.550 s | **13.003 s** |
| `starter-end-to-end.test.ts` | 12.216 s | 12.289 s |
| `typescript-cli-integration.test.ts` | 9.354 s | 9.035 s |
| `typescript-app-loader.test.ts` | 6.440 s | 5.931 s |
| `new.test.ts` | 4.506 s | 4.126 s |
| `generated-runtime-execution.test.ts` | 2.552 s | 2.533 s |
| `declared-trainable-codegen.test.ts` | 2.500 s | 2.192 s |
| `codegen-tree-safety.test.ts` | 1.423 s | 1.248 s |

The package typecheck, focused cache test, full package suite, and changed-scope standards/lint gates protect the change. No protobuf, CUE, or PACT contract changed. The package README documents test coverage rather than test cost, so this finding carries the timing note without adding stale performance numbers to that README.
