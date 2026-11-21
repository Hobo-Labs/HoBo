# @hobo/agent-skills

The mirrored `.agents/skills` tree as a **distributable module**
: a typed skills manifest (name / description / entry
per skill), strict frontmatter parsing, and a conformance check every skill
must pass. Distribution rides Registry listings the same way Resource Packs
do — the manifest in
[`data-models/agent_skills.proto`](./data-models/agent_skills.proto) is what
a listing serves (boundary fixtured in
[`contracts/pacts/agent-skills-manifest.pact.json`](./contracts/pacts/agent-skills-manifest.pact.json)).

- `parseSkillFrontmatter(markdown)` — parse, don't validate: the SKILL.md
  YAML frontmatter lowers onto parsed derived types (`SkillManifestEntry`)
  or throws a typed `SkillParseError`; missing/empty name or description and
  malformed single- or double-quoted scalars never survive. Single-quoted
  scalars must consume the whole value and may contain quotes only as doubled
  escapes.
- `loadSkillsManifest(root)` — scans a skills tree (one directory per
  skill, each with a `SKILL.md`) into a `SkillsManifest`, deterministically
  sorted by name.
- `checkSkillsConformance(root, options?)` — the bundle gate: every skill
  directory parses, no duplicate names, entry paths exist. Skills in the
  optional `strictSkillNames` set (`discoverHoboOwnedSkillNames` derives it
  from every skill directory with a `SKILL.md`, excluding only the reviewed
  vendored-name allowlist in `src/index.ts` when that name also appears in
  `skills-lock.json`) are additionally held to the repository's own frontmatter
  rules: only Agent Skills fields this repo controls, name equal to the folder,
  and `metadata` as a map of decoded, non-empty string values. Unrecognized
  non-comment top-level YAML lines fail closed instead of being ignored.
  `skillsLockExemptionIssues` rejects a lock entry for any unapproved in-tree
  skill, regardless of its declared source, so lock metadata cannot re-label
  repo-owned, forked, or copied content as vendored. GitHub shorthand, HTTP(S),
  `github:`, and SSH/SCP source spellings normalize to exactly one owner and
  repository; missing, malformed, ambiguous, and non-HoBo sources still fail
  closed. Any normalized `Hobo-Labs/HoBo` source reports the repo-skill
  exemption violation. The portable `hobo-setup` and `hobo-deploy` set is always
  excluded from locking, and callers can add repo-authored names through
  `neverLockSkillNames`.
  The repo's `skills:mirror-check` remains the parity gate between
  `.agents/skills` and `.claude/skills`; this check layers the per-skill
  contract on top.

For portable installation outside this repository, [`plugins/hobo`](../../plugins/hobo)
packages the HoBo MCP server plus the `hobo-setup` and `hobo-deploy` skills
as an Agent Plugins 1.0.0 plugin (`pnpm run agent-plugin:build` produces its
bundled server; `pnpm run agent-plugin:check` builds `@hobo/agent-skills`
before gating manifest, wiring, and skill sync against the vendored 1.0.0
schemas).

This package emits no events: skills are static content. In the platform's
command → event pipeline, a Registry import is the command and the
Registry's actors append `registry.BundleImported` facts to the event
store; materialized views / projections (with snapshots feeding read
stores) list installed bundles — this package supplies only the parsed
manifest those flows consume.
