# Relay bootstrap

Use these paths when the deployed relay is unavailable.

After the fix is merged to `main`, dispatch the direct HoBo CD deployment:

```sh
gh workflow run relay-deploy.yml -f force_bootstrap=true
```

Alternatively, on a development machine authenticated to the relay's secret store, set the intended revision once and use one `HOBO_HOME` for both commands. The second command is refused unless the first qualified that exact commit in this journal:

```sh
export HOBO_HOME="${HOBO_HOME:-$HOME/.hobo}"
export HOBO_CI_RELAY_URL="https://hobo-ci.vercel.app"
ref=main
sha=<40-character-lowercase-commit>

hobo ci deploy --cwd packages/ci-vercel --ref "$ref" --sha "$sha" \
  --target preview --build prebuilt --provision --wait
hobo ci deploy --cwd packages/ci-vercel --ref "$ref" --sha "$sha" \
  --target production --build prebuilt --provision --wait
```

Do not change `HOBO_HOME` between commands: production consumes preview's qualification from the CD journal under that home. Production also verifies that `HOBO_CI_RELAY_URL/healthz` serves `$sha` and that `/readyz` answers 200.

Run both from a checkout at `$sha`: preview builds that checkout once and stages it, and production promotes that same build, rolling back if production verification fails.

Never Git-link the Vercel project or use `hobo ci deploy --adopt`. Bootstrap uses direct HoBo CD deployment only.
