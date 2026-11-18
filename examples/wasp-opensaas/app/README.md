# Open SaaS example

Built with [Wasp](https://wasp.sh), based on the [Open Saas](https://opensaas.sh) template.

## Development

### Running locally

- Make sure you have the `.env.client` and `.env.server` files with correct dev values in the root of the project.
- Run the database with `wasp start db` and leave it running.
- Run `wasp start` and leave it running.
- [OPTIONAL]: If this is the first time starting the app, or you've just made changes to your entities/prisma schema, also run `wasp db migrate-dev`.

### Verification

Run `npm run test:unit` for the local browser-state and payment-boundary tests.
HoBo `agent:check` uses `npm run ci:test:unit` here: `scripts/ensure-vitest-install.mts`
creates `file:.wasp/spec` only when missing, then
`npm install --workspaces=false --include=dev`, then vitest with
`NODE_ENV=development` (so devDependencies install under a production shell and React
`act` is available). `vitest` is already in `devDependencies`;
this lane adds `@testing-library/react`, `@testing-library/dom`, `jsdom`, and the tests.
Run `wasp compile` to check the generated SDK and application types; a running
PostgreSQL instance is needed to verify that database migrations are current.
