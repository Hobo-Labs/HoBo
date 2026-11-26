---
type: Agent Skill Reference
title: "Repo setup"
description: "Initialize and repair the HoBo repo environment without widening scope or hiding setup failures."
tags: [hobo, repo, setup, agent-skill]
timestamp: 2026-06-30T00:00:00Z
---

# Repo Setup

Start every repo task by reading `AGENTS.md`, checking `git status --short`, and identifying existing staged or unstaged work. Treat existing changes as user-owned unless you made them in the current task.

## Setup Rules

- Use `pnpm` for all package commands (works on every platform; the shell resolves the right shim).
- Use `pnpm run install:check` when dependency state must be verified.
- Use `pnpm run setup` only for first-run setup or when generated contracts are known stale.
- Do not delete `node_modules`, run `pnpm update`, or prune the pnpm store unless the task explicitly changes dependency or install state.
- Keep agent config mirrored across supported agents when changing `.agents`, `.claude`, `.codex`, `.cursor`, `.mcp.json`, or setup scripts.

## Initialization Flow

1. Verify repository root and current branch.
2. Read the task-specific docs or skill references.
3. Search for existing commands before inventing new scripts.
4. Install only when commands fail from missing dependencies or the task is setup-related.
5. Record setup or tooling behavior in `docs/agent-tooling.md` or the nearest maintenance doc.
