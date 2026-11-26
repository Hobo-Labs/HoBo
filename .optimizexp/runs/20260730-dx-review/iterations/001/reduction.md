# Reduction plan (report-only)

User did not request fixes (`ALLOW_OPTIMIZEXP_FIXES` unset). No product code changed.

## Recommended order

1. **F-2** (harness pipefail) — unblocks trustworthy optimizexp evidence; skill-local.
2. **F-1** preflight messaging — one-line install-first before stack on `agent:check` / `doctor`.
3. **F-3** offline doctor path — zero-setup health for cold clones.
4. Re-run `/optimizexp --dx --iterations 2` after install **or** after preflight lands to re-score post-reduction.

## Out of scope this pass

- Running `pnpm install` (changes environment; not an experience fix).
- Implementing script preflight without user request.
