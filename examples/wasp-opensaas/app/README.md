# Open SaaS example

Built with [Wasp](https://wasp.sh), based on the [Open Saas](https://opensaas.sh) template.

## Development

### Running locally

- Make sure you have the `.env.client` and `.env.server` files with correct dev values in the root of the project.
- Run the database with `wasp start db` and leave it running.
- Run `wasp start` and leave it running.

### Existing databases

For an existing database matching the original example schema and without a
record of these migrations, back it up, then set `DATABASE_URL` and run:

```sh
npx prisma migrate resolve --schema schema.prisma --applied 20261116000000_initial
npx prisma migrate deploy --schema schema.prisma
```

New databases receive both migrations through the normal Wasp migration flow.

- [OPTIONAL]: If this is the first time starting the app on an already baselined database, or you've just made changes to your entities/prisma schema, also run `wasp db migrate-dev`.
### Client configuration

Set `REACT_APP_PLAUSIBLE_DOMAIN` to enable Plausible analytics. Set
`REACT_APP_PRIVACY_POLICY_URL` and `REACT_APP_TERMS_URL` to HTTP(S) URLs or
root-relative paths to display those links in the consent banner. Leave these
values empty when the corresponding service or document is unavailable.

### Verification

Run `npm run test:unit` for the local browser-state, message indicator, payment-boundary, and profile settings tests. Set `TEST_DATABASE_URL` to an isolated PostgreSQL database with the application schema applied to include the message and profile operation tests.
HoBo `agent:check` uses `npm run ci:test:unit` here: `scripts/ensure-vitest-install.mts`
creates `file:.wasp/spec` only when missing, then
`scripts/ci-test-unit.mts` installs dev dependencies only when `node_modules`
is missing them (still `--no-package-lock`; repo gitignores example lockfiles), then
vitest — `vitest.config.ts` sets `NODE_ENV=development` for
React `act` under a production shell. `vitest` is already in `devDependencies`;
this lane adds `@testing-library/react`, `@testing-library/dom`, `jsdom`, and the tests.
Run `wasp compile` to check the generated SDK and application types; a running
PostgreSQL instance is needed to verify that database migrations are current.