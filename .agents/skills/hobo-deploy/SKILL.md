---
name: hobo-deploy
description: Use when running a HoBo deployment that needs a config/secret store — deploying the hosted CI relay (`hobo ci deploy`), or any `hobo deploy` whose Yard binds `secrets.config-service/v1`. HoBo chooses the store when the deployment runs, provisions it, and hands it to the owner by claim; the agent surfaces claim links at the right moment instead of a setup checklist, and never puts anything in Vercel or GitHub secrets or variables.
---

# HoBo deployment: the secret store is chosen at deploy and handed over by claim

ADR-0179's amendment "Secret store chosen at deploy, provisioned by claim"
(`docs/design/adr/hosted-relay-stateless.md`) is the rule. Read it before a
first deploy. In one line: **no human pre-setup, nothing in Vercel env
secrets, nothing in GitHub secrets or variables; the store is the one HoBo
routes `secrets.config-service/v1` to when the deployment runs, and the owner
takes it by claim.**

## Never

- Never ask the owner to work through a setup checklist, create an Infisical
  organization by hand, or paste ids into repository variables. If you are
  about to, stop: that is the design this skill replaces.
- Never put a value in `vercel env`, `gh secret set`, `gh variable set`, or a
  committed file other than `deploy/secret-store.binding.json` (coordinates
  only).
- Never run `hobo claim open` yourself, and never read, print, summarise or
  store a claim link, password or token. Claim links are bearer credentials:
  the owner opens them in their own terminal. If one reaches your context by
  accident, say so and do not repeat it.
- Never accept a provider's terms for the owner. Cloudflare's temporary
  account needs the owner's own "y" at the prompt `hobo ci secret-store
  provision` shows in their terminal.

## The loop

1. **Plan.** In the relay's project directory (`packages/ci-vercel`, or pass
   `--cwd`):

   ```sh
   hobo ci secret-store plan --json \
     [--auth-md https://<a store that publishes auth.md>] \
     [--fleet-host https://<fresh Infisical on a compute fleet host>]
   ```

   It names the offer HoBo chose and why each preferred one was passed over.
   Preference: (1) any store that publishes auth.md with anonymous agent
   registration; (2) a Cloudflare temporary account (an experiment, below,
   never the relay's store); (3) HoBo-hosted Infisical on the owner's compute
   fleet; (4) an Infisical Cloud organization the owner already has
   (attach-only). Offers whose runtime binding is only designed are passed
   over unless `--allow-designed` is given; say so plainly when that happens.

2. **Tell the owner what is about to happen, once, in plain words**: which
   store, what it costs (`offers[].cost`), what its availability means for the
   relay (`offers[].availability`), and that a claim step follows. Ask before
   anything chargeable.

3. **Provision.**

   ```sh
   hobo ci secret-store provision --team <team_id> \
     --vercel-team-slug <slug> --vercel-project-id <prj_id> \
     [--fleet-host https://...] [--owner-email <owner's address>]
   ```

   It writes `deploy/secret-store.binding.json` (coordinates only) when the
   relay can read the store, and records a HoBo claim bundle. It prints the
   owner's next steps; it never prints a claim link.

4. **Surface the claim at the right moment.** Immediately after provision,
   relay `data.claimSteps` to the owner verbatim, with the deadline
   (`data.claim.deadline`). For a Cloudflare temporary account the deadline is
   60 minutes and an unclaimed account is deleted, so lead with it. The owner
   runs, in their own terminal:

   ```sh
   hobo claim open secret-store --cwd packages/ci-vercel
   ```

   then completes the provider's step (Cloudflare's claim page; the store's
   auth.md approval page; or signing in to the self-hosted Infisical and
   changing the password).

5. **Finalize.** When the owner says they are done:

   ```sh
   hobo claim finalize secret-store --cwd packages/ci-vercel
   hobo claim status --cwd packages/ci-vercel
   ```

   For self-hosted Infisical, finalize deletes HoBo's bootstrap identity and
   verifies that Infisical refuses its token. A provider whose verification is
   designed only is refused here; report that, do not mark it done.

6. **Commit the binding** (`deploy/secret-store.binding.json`) in a PR. The
   deploy workflow (`.github/workflows/relay-deploy.yml`) gates on it and
   reads no repository variable. Then `hobo ci deploy --target production`
   (or the workflow on `main`) reads the binding for the team and the store's
   coordinates.

## The Cloudflare claim-link experiment (only when the owner asks for it)

Not part of a relay deployment: the relay keeps its Vercel project and
Infisical. It proves HoBo can hand the owner a valid Cloudflare claim link
(ADR-0179 amendment, "The Cloudflare experiment"). The owner runs it once,
in their own interactive terminal, because they must type the acceptance:

```sh
hobo ci secret-store provision --offer cloudflare-temporary \
  [--experiment-worker --team <team_id> --vercel-team-slug <slug> --vercel-project-id <prj_id>]
```

Before they run it, tell them: it creates a real temporary Cloudflare
account; they must type `accept` for Cloudflare's Terms of Service and
Privacy Policy (you never answer that prompt); then **within 60 minutes**
they run `hobo claim open secret-store` and complete Cloudflare's claim page,
or Cloudflare deletes the account and everything in it. Relay
`data.experiment.claimDeadline` and, with `--experiment-worker`,
`data.experiment.worker` (serving, or the stage and code where it failed;
the claim link is handed over either way). `hobo claim finalize secret-store`
verifies only with the Worker, and only from 15 minutes after the deadline;
without it, finalize refuses (Cloudflare documents no claim status) and the
owner confirms in the dashboard.

## The other claim steps of a relay deployment

- **Vercel project.** Vercel's claimable deployments (`vercel deploy
  --temporary`) always create a new project, refuse to run in CI or in a
  linked directory, and move the whole project on claim; they cannot deploy
  into an existing project. When the relay has no project yet, the owner
  claims the one a temporary deploy made (one browser click on Vercel's claim
  page). An existing project stays where it is.
- **GitHub App.** The App manifest flow is one browser click by design.
  `hobo ci app create` drives it; treat its "Create GitHub App" page as a
  claim step: tell the owner what they are approving and wait.

## Reporting

End with: the store chosen and why; which claim steps are done, pending
(with deadlines), or impossible to automate (and the vendor reason); and the
PR that commits the binding. Never a link, a password or a token.
