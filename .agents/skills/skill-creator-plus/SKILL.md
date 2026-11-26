---
name: skill-creator-plus
description: Create or improve complete repository skills with precise triggers and actionable instructions.
metadata:
  short-description: Create complete repository skills.
---

# Skill Creator Plus

Follow `AGENTS.md`. Inspect the task and existing skills, then write complete,
actionable instructions that add useful capability. Do not create placeholder
scripts, unfinished sections, planning documents, or design documents.

To create a skill, place the finished instructions in a temporary file and run:

```bash
python3 .agents/skills/skill-creator-plus/scripts/init_skill.py <skill-name> \
  --path <output-directory> \
  --description <single-line-description> \
  --instructions-file <completed-instructions-file>
```

Validate the resulting `SKILL.md` with
`python3 .agents/skills/skill-creator-plus/scripts/quick_validate.py <skill-directory>`.
Add scripts, references, or assets only when they implement a real requirement,
and verify the resulting skill before reporting completion.
