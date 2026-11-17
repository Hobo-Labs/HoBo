# Experience checks

Use the [OptimizeXP skill](../.agents/skills/optimizexp/SKILL.md) to inspect real behavior, implement improvements, and verify the affected path. Do not create planning documents, synthetic personas, or review backlogs.

`pnpm run optimizexp:check` validates existing feature metadata and historical bus records. Check individual bindings with `generate-feature.mts --mode validate --id <feature>`, and use the affected product tests and real entrypoints to verify fixes. Existing recordings and manifests are evidence, not a substitute for working behavior.

List configured projects with `node --import tsx .agents/skills/optimizexp/harness/init.mts --mode list-projects` and validate their configuration with `--mode validate-config`. Historical bus records can be inspected with `node --import tsx .agents/skills/optimizexp/workflows/cross-agent/review-loop.mts --mode validate-bus`.
