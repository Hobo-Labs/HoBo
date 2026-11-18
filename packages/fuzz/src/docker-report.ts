import type { JsonObject, JsonValue } from "@hobo/core";

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return (
		value !== null &&
		value !== undefined &&
		!Array.isArray(value) &&
		Object.prototype.toString.call(value) === "[object Object]"
	);
}

function isJsonNumber(value: JsonValue | undefined): value is number {
	return (
		Object.prototype.toString.call(value) === "[object Number]" &&
		Object(value) !== value &&
		Number.isFinite(value)
	);
}

export interface DockerCampaignReport {
	readonly fault: {
		readonly latency_ms: number;
		readonly bandwidth_ms: number;
		readonly timeout: true;
		readonly reset: true;
		readonly cut: true;
		readonly idempotent: true;
	};
	readonly database: { readonly reset: true; readonly idempotent: true };
	readonly queue: { readonly reset: true; readonly idempotent: true };
	readonly registry: {
		readonly cut_recovered: true;
		readonly blob_roundtrip: true;
	};
	readonly restler: {
		readonly coverage: "4 / 4";
		readonly valid: "4 / 4";
		readonly requests: Readonly<Record<string, number>>;
		readonly bugs: Readonly<Record<string, never>>;
	};
}

export function parseDockerCampaignReport(text: string): DockerCampaignReport {
	const report: JsonValue = JSON.parse(text);
	if (
		!isJsonObject(report) ||
		!isJsonObject(report.fault) ||
		!isJsonObject(report.database) ||
		!isJsonObject(report.queue) ||
		!isJsonObject(report.registry) ||
		!isJsonObject(report.restler)
	)
		throw new Error("invalid Docker campaign report");
	const { fault, database, queue, registry, restler } = report;
	if (
		!isJsonNumber(fault.latency_ms) ||
		!Number.isFinite(fault.latency_ms) ||
		fault.latency_ms < 120 ||
		!isJsonNumber(fault.bandwidth_ms) ||
		!Number.isFinite(fault.bandwidth_ms) ||
		fault.bandwidth_ms < 200 ||
		fault.timeout !== true ||
		fault.reset !== true ||
		fault.cut !== true ||
		fault.idempotent !== true
	)
		throw new Error("fault injection did not meet the campaign requirements");
	if (
		database.reset !== true ||
		database.idempotent !== true ||
		queue.reset !== true ||
		queue.idempotent !== true ||
		registry.cut_recovered !== true ||
		registry.blob_roundtrip !== true
	)
		throw new Error(
			"dependency recovery did not meet the campaign requirements",
		);
	if (
		restler.coverage !== "4 / 4" ||
		restler.valid !== "4 / 4" ||
		!isJsonObject(restler.requests) ||
		!isJsonObject(restler.bugs) ||
		Object.keys(restler.bugs).length !== 0
	)
		throw new Error("RESTler did not meet the campaign requirements");
	const requestEntries: Array<[string, number]> = [];
	for (const [name, count] of Object.entries(restler.requests)) {
		if (!isJsonNumber(count) || !Number.isSafeInteger(count) || count < 0)
			throw new Error("invalid RESTler request count");
		requestEntries.push([name, count]);
	}
	const requests = Object.fromEntries(requestEntries);
	if (
		!Object.hasOwn(requests, "main_driver") ||
		!isJsonNumber(requests.main_driver) ||
		requests.main_driver < 1
	)
		throw new Error("RESTler did not send requests");
	return {
		fault: {
			latency_ms: fault.latency_ms,
			bandwidth_ms: fault.bandwidth_ms,
			timeout: true,
			reset: true,
			cut: true,
			idempotent: true,
		},
		database: { reset: true, idempotent: true },
		queue: { reset: true, idempotent: true },
		registry: { cut_recovered: true, blob_roundtrip: true },
		restler: { coverage: "4 / 4", valid: "4 / 4", requests, bugs: {} },
	};
}
