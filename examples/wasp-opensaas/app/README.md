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
HoBo `agent:check` uses `npm run ci:test:unit` here because this app is outside the
pnpm workspace.
Run `wasp compile` to check the generated SDK and application types; a running
PostgreSQL instance is needed to verify that database migrations are current.
