# Removing HoBo CI Cleanly

Every workflow edit written by `hobo ci init --apply` preserves the previous runner label in a trailing `# was <label>` comment (for example, `runs-on: hobo # was ubuntu-24.04`), so removing HoBo CI restores the repository cleanly with no leftover workflow jobs.

## Steps

1. **Restore workflow `runs-on` labels:**

   Replace each `runs-on: hobo # was <original>` line back to `runs-on: <original>` (or run `restoreWorkflowPlan` from `@hobo/ci-gh-actions` across `.github/workflows/*.yml`).

   Verify the diff restores every workflow to its pre-HoBo labels:

   ```sh
   git diff .github/workflows/
   ```

2. **Remove repository routing config (optional):**

   Delete `.hobo/ci.json` if no other HoBo CI settings are needed, then commit and merge the pull request.

3. **Disconnect personal machines and release adopted runners:**

   ```sh
   hobo ci machine remove <machine-id>
   hobo ci runners release <runner-id>
   ```

4. **Uninstall the HoBo GitHub App:**

   Uninstall the HoBo CI GitHub App from the repository or organization settings in GitHub. No Actions secrets, repository variables, or permanent self-hosted runners remain on GitHub.
