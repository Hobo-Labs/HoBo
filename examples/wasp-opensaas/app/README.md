# Open SaaS example

Built with [Wasp](https://wasp.sh), based on the [Open Saas](https://opensaas.sh) template.

## Development

### Running locally

- Make sure you have the `.env.client` and `.env.server` files with correct dev values in the root of the project.
- Run the database with `wasp start db` and leave it running.
- Run `wasp start` and leave it running.
- [OPTIONAL]: If this is the first time starting the app, or you've just made changes to your entities/prisma schema, also run `wasp db migrate-dev`.

### Existing databases

For an existing database matching the original example schema and without a
record of these migrations, back it up, then set `DATABASE_URL` and run:

```sh
npx prisma migrate resolve --schema schema.prisma --applied 20261116000000_initial
npx prisma migrate deploy --schema schema.prisma
```

New databases receive both migrations through the normal Wasp migration flow.

### Client configuration

Set `REACT_APP_PLAUSIBLE_DOMAIN` to enable Plausible analytics. Set
`REACT_APP_PRIVACY_POLICY_URL` and `REACT_APP_TERMS_URL` to HTTP(S) URLs or
root-relative paths to display those links in the consent banner. Leave these
values empty when the corresponding service or document is unavailable.

### Verification

Run `npm run test:unit` for the local browser-state, message indicator, and payment-boundary tests. Set `TEST_DATABASE_URL` to an isolated PostgreSQL database with the application schema applied to include the message and profile operation tests; these database cases are skipped when it is unset.
Run `wasp compile` to check the generated SDK and application types; a running
PostgreSQL instance is needed to verify that database migrations are current.
