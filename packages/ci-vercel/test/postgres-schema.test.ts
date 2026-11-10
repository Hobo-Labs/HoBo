import { defineSchemaSuite } from "../../ci/db/tooling/suite.js";
import { schemaSource } from "../db/source.js";

defineSchemaSuite(schemaSource, {
	tables: ["hobo_ci_database_probes", "hobo_ci_worker_health"],
	impedance: {
		// `created_at DEFAULT now()`.
		DRIZZLE_DEFAULT_UNREPRESENTABLE: 1,
	},
	fallbacks: 0,
	control: {
		find: "DEFAULT now()",
		replace: "DEFAULT clock_timestamp()",
		surfacesAs: "column hobo_ci_database_probes.created_at",
	},
});
