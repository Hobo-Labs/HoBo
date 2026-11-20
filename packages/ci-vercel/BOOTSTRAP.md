# Relay bootstrap

Use these paths when the deployed relay is unavailable.

After the fix is merged to `main`, dispatch the direct HoBo CD deployment:

```sh
gh workflow run relay-deploy.yml -f force_bootstrap=true
```

Alternatively, on a development machine with `VERCEL_TOKEN` available, run:

```sh
hobo ci deploy --provision --wait
```

Never Git-link the Vercel project or use `hobo ci deploy --adopt`. Bootstrap uses direct HoBo CD deployment only.
