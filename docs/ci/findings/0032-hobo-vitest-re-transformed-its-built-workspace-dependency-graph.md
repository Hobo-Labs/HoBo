---
type: CI Performance Finding
title: "Finding 32: hobo Vitest re-transformed its built workspace dependency graph"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 32: hobo Vitest re-transformed its built workspace dependency graph

Merge-group run **41833733901** timed out `test/mcp-stdio.test.ts` after **10 s**. Five loaded single-test runs showed a **40 ms** median test body but a **9.89 s** median file duration (transform **5.49 s**, import **9.50 s**). Temporary instrumentation measured composed-CLI construction at **15.4 ms**, project-target resolution at **1.3 ms**, and dispatch at **25.6 ms**; the full-suite dispatch took **11.6 ms**. No timer, poll, subprocess, or ambient-tool probe was on the collect path. The cost was Vite transforming hundreds of already-built workspace modules pulled in by the composed CLI.

The package Vitest config now externalizes resolved `packages/**/dist/**` files so Node loads workspace exports natively while hobo's own source and tests still go through Vite. `@hobo/cli` stays inline because its dynamic bindle imports need Vite to resolve `.js` specifiers in TypeScript sources. Under the same four-hog load, five-run medians fell to **4.41 s** per file, **1.04 s** transform, and **3.88 s** import; the test body remained fast at **43 ms**. The composed-registry assertions and 10 s timeout are unchanged.
