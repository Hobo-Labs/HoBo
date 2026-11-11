---
type: CI Performance Finding
title: "Finding 98: main gate finish checkout guard"
description: "Transient actions/checkout metadata download timeouts left finish without a tree; ci-trace then failed and turned main red."
tags: [hobo, ci, main-gate, gitleaks, ci-trace]
---

# Finding 98: main gate finish checkout guard

**Status:** mitigated  
**First seen:** Main Fabric 42987900597 — `Main full gate (finish)` action download timeout, then `Cannot find module .../ci-trace.mts`.

## Symptom

`Failed to resolve action download info` (100s) on bootstrap checkout. Later steps still ran; `ci-trace` threw because the workspace never contained `scripts/`.

## Change

- Bootstrap and full checkout: `continue-on-error` plus sparse/full git fetch fallbacks (no GitHub Actions metadata download).
- `workspace.ready` output gates gitleaks, preflight, and trace when checkout did not populate scripts.
- `ci-trace` composite no-ops when `scripts/ci/ci-trace.mts` is missing (belt-and-suspenders).

## Proof

- `.github/workflows/hobo-ci.yml` (`main_gate_finish`)
- `scripts/test/ci-trace-action.test.ts`
- `.github/actions/ci-trace/action.yml`
