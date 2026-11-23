---
type: Agent Skill Reference
title: "Experience PR delivery"
description: "Deliver verified experience improvements in incremental commits."
tags: [hobo, optimizexp, pr, evidence]
---

# PR delivery

Implement the requested behavior and commit each verified increment. When the user requests stacked pull requests, base each dependent branch on the preceding branch and submit the stack with the repository's configured tool.

Describe observable behavior and the checks performed in the pull request. Link existing evidence when it helps reviewers assess the change. Do not create synthetic review scaffolds, planning artifacts, or invented evidence.

## Posting evidence to the PR

```bash
node --import tsx .agents/skills/optimizexp/harness/post-pr-evidence.mts \
  --feature <feature-id> \
  --pr <number>
# Omit --pr to auto-detect the current branch's PR.
```

Posting accepts consistent evidence while playback review is pending. The
manifest and metadata must identify the same primary and match its current
digest; an accepted review must also match that artifact. The index reports
the review status. File paths and transcript text are formatted as literal
evidence, including when they contain Markdown delimiters; malformed kind names
are rejected before posting. If a feature ID exists in multiple scopes, pass
`--project <id>` (or `--project root`) to select one; posting refuses an
ambiguous or missing selection. A failed scenario comment makes the command
fail after it reports every attempted comment.

The command posts a scenario index and one comment per scenario. It references
small images and GIFs and includes excerpts from small transcripts; videos and
larger files use their repository paths. The command does not upload or
compress files, so commit and push the evidence before posting. Image references
are limited to 1,000,000 bytes and GIF references to 2,000,000 bytes. Transcript
excerpts are clipped to 12,000 characters.

Never commit secrets in evidence. Never paste binary base64 walls into PR bodies when a path link suffices.
