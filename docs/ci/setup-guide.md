# HoBo CI One-Prompt Setup Guide

Use this guide when setting up HoBo CI for a GitHub Actions repository from a single prompt or operator session.

## Prerequisites

- The `hobo` CLI installed (`hobo --version`).
- A GitHub repository checkout with `.github/workflows/*.yml`.
- A configured secret store (`choose_secret_store` or `hobo ci connect`); HoBo connects to GitHub exclusively through its own GitHub App and never stores personal tokens or Actions secrets.

## Single-Prompt Setup Steps

1. **Connect the repository and GitHub App:**

   ```sh
   hobo ci connect
   ```

   Follow the owner hand-off link to install HoBo's GitHub App on the repository.

2. **Define the repository runner order in `.hobo/ci.json`:**

   ```json
   {
     "runnerOrder": {
       "steps": [
         { "key": "machine" },
         { "key": "depot", "spendLimitUsd": 50 },
         { "key": "github", "minutesLimitPercent": 80 }
       ],
       "skipUnhealthy": true,
       "autoSizeVcpus": 4,
       "retry": { "enabled": true, "target": "other", "maxRetries": 2 }
     },
     "checks": {
       "prTitle": { "types": ["feat", "fix", "chore", "docs", "refactor", "test"] },
       "lint": true
     }
   }
   ```

3. **Preview routing without modifying workflows:**

   ```sh
   hobo ci route --machine self-hosted --depot auto --github ubuntu-24.04 --json
   ```

4. **Plan and apply workflow updates (never commits automatically):**

   ```sh
   hobo ci init --json
   hobo ci init --apply all
   git diff .github/workflows/
   ```

   Review the diff, then commit and open a pull request to enable HoBo routing.

5. **Optionally connect a personal machine or adopt an existing self-hosted runner:**

   ```sh
   hobo ci machine connect
   hobo ci runners list
   hobo ci runners adopt <runner-id>
   ```

6. **Verify live activity, usage, performance, and provider health:**

   ```sh
   hobo ci activity --since 7d --json
   hobo ci usage --json
   hobo ci performance --json
   hobo ci provider-health --json
   ```
