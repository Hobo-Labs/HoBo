// Typed failure modes of the telemetry plane (WP19). Telemetry is advisory:
// callers of a TelemetrySink swallow these, but the sink raises them so an
// operator-facing caller (health, CLI, tests) can see exactly what failed.

// public-contract: telemetry failure codes with remediation.
export const TELEMETRY_FAILURES = Object.freeze({
	"otlp-endpoint-invalid": {
		remediation:
			"Set the OTLP endpoint to an absolute http(s) base URL without a query, e.g. http://otel-collector:4318.",
	},
	"otlp-rejected": {
		remediation:
			"The collector refused the payload with a non-retryable status. Check collector auth headers and the OTLP/HTTP JSON receiver config; the batch was dropped.",
	},
	"otlp-retries-exhausted": {
		remediation:
			"The collector stayed unavailable (429/502/503/504 or transport error) for every attempt. Check collector health and capacity; the batch was dropped.",
	},
	"otlp-partial-success": {
		remediation:
			"The collector accepted the batch but rejected some items; see the message for the collector's reason (usually invalid attributes or limits).",
	},
	"telemetry-tenant-mismatch": {
		remediation:
			"The request context names a different tenant than this telemetry projection serves. Query that tenant's telemetry instead; projections never cross tenants.",
	},
} as const);

export type TelemetryFailureCode = keyof typeof TELEMETRY_FAILURES;

export class TelemetryError extends Error {
	readonly code: TelemetryFailureCode;
	readonly remediation: string;
	readonly status: number | undefined;
	constructor(code: TelemetryFailureCode, message: string, status?: number) {
		super(message);
		this.name = "TelemetryError";
		this.code = code;
		this.remediation = TELEMETRY_FAILURES[code].remediation;
		this.status = status;
	}
}
