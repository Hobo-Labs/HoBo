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
