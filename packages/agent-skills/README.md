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
  or throws a typed `SkillParseError`; missing/empty name or description
  never survives.
- `loadSkillsManifest(root)` — scans a skills tree (one directory per
  skill, each with a `SKILL.md`) into a `SkillsManifest`, deterministically
  sorted by name.
- `checkSkillsConformance(root)` — the bundle gate: every skill directory
  parses, no duplicate names, entry paths exist. The repo's
  `skills:mirror-check` remains the parity gate between `.agents/skills`
  and `.claude/skills`; this check layers the per-skill contract on top.

This package emits no events: skills are static content. In the platform's
command → event pipeline, a Registry import is the command and the
Registry's actors append `registry.BundleImported` facts to the event
store; materialized views / projections (with snapshots feeding read
stores) list installed bundles — this package supplies only the parsed
manifest those flows consume.
