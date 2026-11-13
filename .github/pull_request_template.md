## Summary

-

## Documentation

- [ ] README/design/proof docs updated, or not needed because:
- [ ] If code/tooling changed, `npm run docs:freshness` passes.
- [ ] If `src/draft/<kind>/<slug>` implementation changed, `npm run architecture:guard` passes with PACT/protobuf/CUE/parse/event evidence.
- [ ] If public CLI examples changed, `npm run docs:cli-lint` passes.
- [ ] If design terms/events/ADRs changed, `npm run docs:design-lint` and traceability validation pass.

## Production observation

- [ ] Not needed: this change adds or alters no channel between two deployed components.
- [ ] A channel between two deployed components is added or altered, and one production observation of it carrying a value is linked here (a run, a log line, a status read): <!-- link --> . Until it is, the change is built, not done (AGENTS.md "Channels between deployed components need one production observation").

## Testing

- [ ] `npm run architecture:guard`
- [ ] `npm test`
- [ ] `npm run docs:cli-lint`
- [ ] `npm run docs:design-lint`
- [ ] `npm run docs:coverage`
- [ ] `npm run docs:freshness`
- [ ] `node --import tsx scripts/validate-traceability.ts`
- [ ] `node --import tsx scripts/validate-sdk-contracts.ts`
- [ ] `node --import tsx scripts/validate-deployment-set-delta.ts`

## Notes / limitations

-
