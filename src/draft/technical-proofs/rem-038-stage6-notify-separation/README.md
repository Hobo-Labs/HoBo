# REM-038 stage-6 notify vs governance separation

Docs-only drift remediation for [HOBO-701](https://linear.app/quickdeploy-ai/issue/HOBO-701): ADR-0064 §3 consolidated `notify` as a cloud-messaging catalog port, not a Plan 46 governance plane. This proof asserts `docs/design/stage-6-production-hardening-acceptance.md` keeps those lanes distinct in Scope In and Evidence Required tables.

## Run

```bash
pnpm --prefix src/draft/technical-proofs/rem-038-stage6-notify-separation test
```
