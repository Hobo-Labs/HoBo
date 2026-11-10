import { defineSchemaSuite } from "../../ci/db/tooling/suite.js";
import { schemaSource } from "../db/source.js";

defineSchemaSuite(schemaSource, {
	tables: [
		"hobo_ci_app_credentials",
		"hobo_ci_app_installations",
		"hobo_ci_app_states",
		"hobo_ci_oauth_sessions",
		"hobo_ci_oauth_states",
		"hobo_ci_platform_app",
		"hobo_ci_platform_app_attempts",
		"hobo_ci_platform_app_invitations",
		"hobo_ci_queued_api_budget",
		"hobo_ci_queued_scans",
		"hobo_ci_webhook_repairs",
		"hobo_ci_webhook_scan_cursors",
		"hobo_ci_webhook_successes",
	],
	impedance: {
		// Three composite primary keys and the singleton check constraint.
		DRIZZLE_EXTRA_CONFIG_UNREAD: 4,
	},
	fallbacks: 0,
	control: {
		find: '"owner_session_started_ms" bigint DEFAULT 0',
		replace: '"owner_session_started_ms" bigint DEFAULT 1',
		surfacesAs: "column hobo_ci_platform_app.owner_session_started_ms",
	},
});
