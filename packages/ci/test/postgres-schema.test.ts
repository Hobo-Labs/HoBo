import { schemaSource } from "../db/source.js";
import { defineSchemaSuite } from "../db/tooling/suite.js";

defineSchemaSuite(schemaSource, {
	migrations: ["0000_baseline", "0001_events_account"],
	tables: [
		"hobo_ci_assigned_jobs",
		"hobo_ci_configuration",
		"hobo_ci_control_records",
		"hobo_ci_events",
		"hobo_ci_inbox",
		"hobo_ci_leases",
		"hobo_ci_partitions",
		"hobo_ci_pending_jobs",
		"hobo_ci_sandbox_egress",
		"hobo_ci_sandbox_proxies",
		"hobo_ci_sandbox_proxy_requests",
		"hobo_ci_snapshot_backups",
		"hobo_ci_terminal_jobs",
	],
	impedance: {
		// `now()` on one column, and the sequence default of three bigserials.
		DRIZZLE_DEFAULT_UNREPRESENTABLE: 4,
		// Nine composite primary keys, two table-level unique constraints and
		// the snapshot-guard check constraint.
		DRIZZLE_EXTRA_CONFIG_UNREAD: 12,
		// The four indexes keyed on `body::jsonb ->> '...'`.
		DRIZZLE_INDEX_EXPRESSION_UNREPRESENTABLE: 4,
		// The three partial inbox indexes.
		DRIZZLE_INDEX_PREDICATE_UNREPRESENTABLE: 3,
	},
	fallbacks: 4,
	control: {
		find: '"seq" DESC NULLS FIRST',
		replace: '"seq" DESC NULLS LAST',
		surfacesAs: "index hobo_ci_events.hobo_ci_events_lease_type_seq",
	},
});
