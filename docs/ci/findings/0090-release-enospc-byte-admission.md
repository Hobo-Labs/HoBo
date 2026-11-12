---
type: CI Performance Finding
title: "Finding 90: release ENOSPC byte admission"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 90: release ENOSPC byte admission

**Status:** mitigated in worker admission  
**Source:** release run `42969407577` (`0.0.0-alpha.94`), leases `0bf7c291` / `c58471e7` (~06:03 UTC)

## Symptom

`Publish GitHub Pages (site/)` and `Build all OCI images on tag (gate publish)` failed with `ERR_PNPM_ENOSPC` (`copyfile` under `/pnpm-store/v10/files/…`) and Actions diagnostics under `/opt/actions-runner/_diag/pages/` reported **No space left on device**. Box telemetry still showed tens of gigabytes free and moderate inode use on the host root.

## Cause

Inode-only reservations admitted multiple trunk release jobs while **per-job workdir + Docker layer growth** on the shared data root could exhaust **bytes on the worker filesystem** even when host-wide `df` looked fine. pnpm fell back to full copies when hardlinks could not be sustained under pressure.

## Fix

- Per-job **storage classes** with byte + inode budgets (`release_trunk` for Pages/npm publish; `runner_image` for OCI matrix builds).
- **Byte reservations** in `createWorkerStorageAdmission` alongside existing inode grants (`hobo_ci_disk_reserve_wait`).
- **Learned peaks** from measured workdir size at teardown (`storage-peaks.json`), blended with class caps like memory admission.
- Jobs still install with `npm_config_package_import_method=hardlink` when the store bind-mount is present.

## Regression

`packages/ci-gh-actions/test/storage-admission.test.ts` and `storage-job-classes.test.ts` pin release job mapping and disk reserve refusal.
