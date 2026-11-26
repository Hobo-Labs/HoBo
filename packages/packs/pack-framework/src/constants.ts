/**
 * Schema identifiers this package must agree with other packages about.
 *
 * `hobo.resource-definition/vNext` is owned by `@hobo/cloud`. It is repeated as
 * a literal here so a pack does not take a runtime dependency on the (private)
 * cloud package just to name a schema version;
 * `test/resource-definition-compat.test.ts` compares this constant against the
 * real `RESOURCE_DEFINITION_VNEXT_SCHEMA` so the two cannot drift silently.
 */
// public-contract: schema identity shared with resource-definition consumers.
export const RESOURCE_DEFINITION_VNEXT_SCHEMA =
	"hobo.resource-definition/vNext" as const;
