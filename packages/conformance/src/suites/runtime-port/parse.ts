import { isJsonObject, type JsonObject, type JsonValue } from "../../json.js";
import {
	RUNTIME_PORT_CONFORMANCE_VERSION,
	type RuntimePortConformanceReport,
} from "./types.js";

export function parseRuntimePortReport(
	raw: JsonValue,
): RuntimePortConformanceReport {
	if (!raw || !isJsonObject(raw) || Array.isArray(raw)) {
		throw new TypeError("report must be an object");
	}

	// SAFETY: assertion to `raw as JsonObject` is required at this boundary.
	const source = raw as JsonObject;
	if (source.contract !== RUNTIME_PORT_CONFORMANCE_VERSION) {
		throw new TypeError("contract must be hobo.runtime-port-conformance/v1");
	}

	const status = source.status;
	if (status !== "pass" && status !== "fail") {
		throw new TypeError("status must be pass or fail");
	}

	const failures = Array.isArray(source.failures) ? source.failures : [];
	if ((status === "fail") !== failures.length > 0) {
		throw new TypeError("status must be fail iff failures is non-empty");
	}

	// SAFETY: assertion to `source.coverage as | { local?: JsonObject } | undefined` is required at this boundary.
	const coverage = source.coverage as { local?: JsonObject } | undefined;
	const local = coverage?.local;
	if (!local || !isJsonObject(local)) {
		throw new TypeError("coverage.local is required");
	}

	const passed = Number(local.passed);
	const failed = Number(local.failed);
	const total = Number(local.total);
	if (passed + failed !== total) {
		throw new TypeError("coverage.local.passed + failed must equal total");
	}

	// SAFETY: assertion to `Object.freeze({ contract: RUNTIME_PORT_CONFORMANCE_VERSION, backend: String(source.backend ?? ""), status, checks: Objec` is required at this boundary.
	return Object.freeze({
		contract: RUNTIME_PORT_CONFORMANCE_VERSION,
		backend: String(source.backend ?? ""),
		status,
		checks: Object.freeze(
			Array.isArray(source.checks)
				? // SAFETY: assertion to `source.checks as RuntimePortConformanceReport["checks"]` is required at this boundary.
					(source.checks as never)
				: [],
		),
		failures: Object.freeze(
			// SAFETY: parsed failures are the report's ConformanceFailure list.
			failures as never,
		),
		coverage: Object.freeze({
			local: Object.freeze({
				status: local.status === "pass" ? "pass" : "fail",
				passed,
				failed,
				total,
			}),
		}),
	}) as RuntimePortConformanceReport;
}
