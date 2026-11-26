/**
 * Cases live in `resource.cases.jsonl`; this file says what the concerns are.
 *
 * Two of them, because the file tests two things: the factory, and the object
 * it returns. `satisfies` is a member of the *result*, so it gets its own
 * subject rather than being smuggled in as a case of `defineResource`.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeConcern } from "@hobo/contract-harness";

import * as resource from "../src/resource.js";
import { defineResource } from "../src/resource.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

describeConcern("defineResource", {
	subject: () => resource,
	cases: path.join(dir, "resource.cases.jsonl"),
});

/** The walkthrough's prod-only HA Postgres, whose verdicts are the second concern. */
const haPostgres = defineResource({
	type: "database",
	engine: "postgres",
	class: "ha",
	with: {
		providerId: "azure",
		definitionId: "azure.flexiblePostgres",
		properties: { ha: true },
		cost: { sku: "flexible-postgres-ha", unit: "month", marginalPrice: "220" },
	},
	match: { envType: "production" },
});

describeConcern("the definition it returns", {
	subject: () => haPostgres,
	cases: path.join(dir, "resource-definition.cases.jsonl"),
});
