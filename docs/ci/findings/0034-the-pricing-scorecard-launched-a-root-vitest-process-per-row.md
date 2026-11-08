---
type: CI Performance Finding
title: "Finding 34: the pricing scorecard launched a root Vitest process per row"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 34: the pricing scorecard launched a root Vitest process per row

Merge-queue run **41844979849** timed out `test/design-scorecard-eval.test.ts > §1.1` after **10 s**, with the file taking **93 s**. Each of the 53 `pass` rows synchronously spawned `pnpm exec vitest run <evidence> -t <name>` from the package test worker. Those tests already execute in their owning packages' test tasks, so the scorecard paid 53 root-runner startups and blocked its event loop without adding behavioral coverage.

The eval now checks evidence statically. It verifies file existence, nearest-package ownership, the package's `vitest run` test script, and placement under `test/` or `contracts/` with a default `.test`/`.spec` suffix (the default-include fallback used by these config-free packages). TypeScript compiler AST analysis builds full test names from enclosing `describe` titles, handles `it`/`test` with `.concurrent` and `.each`, applies `.skip`/`.todo`/`.only` selection, and matches both literal substrings and regular-expression evidence patterns. Unit fixtures cover missing files, renamed or disabled tests, and files outside package test selection. Evidence behavior still runs in the owning package's suite; the scorecard retains the first no-partial/fail/deferred test.

Three runs of `pnpm --filter @hobo/pricing exec vitest run test/design-scorecard-eval.test.ts`, all with 54 passing tests:

| Measurement | Before | After |
|---|---:|---:|
| Vitest file durations | 50.46 s, 50.86 s, 50.69 s | 0.489 s, 0.480 s, 0.480 s |
| **Median file duration** | **50.69 s** | **0.480 s** |
| Shell wall durations | 51.106 s, 51.484 s, 51.326 s | 1.124 s, 1.085 s, 1.095 s |
| **Median wall duration** | **51.326 s** | **1.095 s** |
