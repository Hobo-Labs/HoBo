---
type: CI Performance Finding
title: "Finding 30: the site Vitest config re-inlined the TypeScript compiler"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 30: the site Vitest config re-inlined the TypeScript compiler

Merge-group run **41828663878** timed out the browser-station catalog test after **45.773 s**. The catalog statically reaches `scanDeclaredTrainables` through `synthesize-try-runtime.ts`; its `ts-autocode-grounding` dependency imports the **9 MB** `typescript.js` compiler. The root Vitest config already externalizes that file (Finding 7), but the site's separate config did not inherit the rule, so Vite's SSR pipeline transformed the compiler and warned about its missing source map.

The site config now applies the same `server.deps.external` rule, leaving the compiler on Node's native loader without changing catalog behavior. With four CPU hogs and the CI test environment, the catalog test fell from **4,735 ms to 740 ms**; its file fell from **5.19 s to 1.17 s** (transform **3.38 s to 235 ms**, import **223 ms to 191 ms**). The full 19-file site suite fell from **10.22 s to 3.89 s** (transform **11.04 s to 1.73 s**, import **18.67 s to 4.20 s**), with all 106 tests passing and the source-map warning gone.
