// PACT consumer verification for every external health-source boundary
// (test/verification/pacts/*.pact.json). Each scenario drives the real source
// through a transport that serves the contracted interactions in order: the
// request must match the contract (method, path, query, headers by value or
// matching rule, JSON body) and the source must decode the contracted
// response into the expected samples or typed refusal.
import { create } from "@bufbuild/protobuf";
import type { TransportRequest, TransportResponse } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	Cohort,
	type HealthQueryRecord,
	HealthQueryRecordSchema,
	HealthSourceKind,
} from "../../../src/_generated/cd_pb.js";
import type {
	HealthSamples,
	HealthSource,
	Outcome,
} from "../../../src/ports.js";
import {
	createCloudWatchSource,
	createDatadogSource,
	createHoboMeteringSource,
	createHttpJsonSource,
	createNewRelicSource,
	createPrometheusSource,
	type SourceDeps,
} from "../../../src/verification/sources/index.js";
import { camp, context, MapCredentials, MINUTE, T0 } from "../fakes.js";
import cloudwatch from "../pacts/cloudwatch.pact.json" with { type: "json" };
import datadog from "../pacts/datadog.pact.json" with { type: "json" };
import hoboMetering from "../pacts/hobo-metering.pact.json" with {
	type: "json",
};
import httpJson from "../pacts/http-json.pact.json" with { type: "json" };
import newrelic from "../pacts/newrelic.pact.json" with { type: "json" };
import prometheus from "../pacts/prometheus.pact.json" with { type: "json" };

type PactRequest = Readonly<{
	method: string;
	path: string;
	query?: Readonly<Record<string, readonly string[]>>;
	headers?: Readonly<Record<string, string>>;
	body?: unknown;
	matchingRules?: Readonly<{
		header?: Readonly<
			Record<
				string,
				Readonly<{
					matchers: readonly Readonly<{ match: string; regex?: string }>[];
				}>
			>
		>;
	}>;
}>;
type PactInteraction = Readonly<{
	type: string;
	description: string;
	request: PactRequest;
	response: Readonly<{
		status: number;
		headers?: Readonly<Record<string, string>>;
		body?: unknown;
	}>;
}>;
type Pact = Readonly<{
	metadata: Readonly<{ pactSpecification: Readonly<{ version: string }> }>;
	interactions: readonly PactInteraction[];
}>;

function interaction(pact: Pact, description: string): PactInteraction {
	const found = pact.interactions.find(
		(item) => item.description === description,
	);
	if (!found) throw new Error(`Pact interaction missing: ${description}`);
	return found;
}

function assertMatches(contract: PactRequest, request: TransportRequest): void {
	const url = new URL(request.url);
	expect(request.method).toBe(contract.method);
	expect(url.pathname).toBe(contract.path);
	if (contract.query) {
		const actual: Record<string, string[]> = {};
		for (const [key, value] of url.searchParams)
			actual[key] = [...(actual[key] ?? []), value];
		expect(actual).toEqual(contract.query);
	}
	const headers = Object.fromEntries(
		Object.entries(request.headers).map(([key, value]) => [
			key.toLowerCase(),
			value,
		]),
	);
	for (const [name, expected] of Object.entries(contract.headers ?? {})) {
		const rule = contract.matchingRules?.header?.[name];
		const actual = headers[name.toLowerCase()];
		const regex = rule?.matchers.find(
			(matcher) => matcher.match === "regex",
		)?.regex;
		if (regex) expect(actual).toMatch(new RegExp(regex));
		else expect(actual, `header ${name}`).toBe(expected);
	}
	if (contract.body !== undefined)
		expect(JSON.parse(request.body ?? "null")).toEqual(contract.body);
}

/** Serves the given interactions in order, asserting each request against its contract. */
function pactTransport(interactions: readonly PactInteraction[]) {
	let next = 0;
	const deps: SourceDeps = {
		http: async (request): Promise<TransportResponse> => {
			const item = interactions[next];
			next += 1;
			if (!item)
				throw new Error(`unexpected request ${request.method} ${request.url}`);
			assertMatches(item.request, request);
			return {
				status: item.response.status,
				headers: item.response.headers ?? {},
				body: JSON.stringify(item.response.body ?? null),
			};
		},
		credentials: new MapCredentials({
			prom: { authorization: "Bearer prom-token" },
			dd: { "DD-API-KEY": "dd-api", "DD-APPLICATION-KEY": "dd-app" },
			nr: { "API-Key": "nr-key" },
			aws: {
				accessKeyId: "AKIDEXAMPLE",
				secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			station: { authorization: "Bearer station-token" },
		}),
	};
	return { deps, served: () => next };
}

async function run(
	source: HealthSource,
	query: HealthQueryRecord,
	cohort: Cohort,
): Promise<Outcome<HealthSamples>> {
	const atMs = T0 + 10 * MINUTE;
	return source.query(
		{
			query,
			campId: camp("camp-a"),
			cohort,
			fromMs: T0,
			toMs: atMs,
			signal: new AbortController().signal,
		},
		context(() => atMs),
	);
}

const codes = (outcome: Outcome<HealthSamples>) =>
	outcome.ok ? [] : outcome.reasons.map((reason) => reason.code);
const values = (outcome: Outcome<HealthSamples>) =>
	outcome.ok ? outcome.value.values : undefined;

describe("health-source pacts are v4 synchronous HTTP contracts", () => {
	const pacts: ReadonlyArray<readonly [string, Pact]> = [
		["prometheus", prometheus],
		["datadog", datadog],
		["newrelic", newrelic],
		["cloudwatch", cloudwatch],
		["http-json", httpJson],
		["hobo-metering", hoboMetering],
	];
	for (const [name, pact] of pacts) {
		it(name, () => {
			expect(pact.metadata.pactSpecification.version).toBe("4.0.0");
			expect(
				pact.interactions.every((item) => item.type === "Synchronous/HTTP"),
			).toBe(true);
		});
	}
});

describe("Prometheus source passes its PACT", () => {
	const query = create(HealthQueryRecordSchema, {
		name: "errors",
		source: HealthSourceKind.PROMETHEUS,
		endpointRef: "https://prometheus.example.com",
		query: "sum by (track) (rate(http_errors_total[1m]))",
		cohortLabel: "track",
		credentialRef: "prom",
	});
	it("selects the canary series by label and drops NaN", async () => {
		const pact = pactTransport([
			interaction(
				prometheus,
				"range query for the canary cohort, step aligned to a 10 minute window",
			),
		]);
		expect(
			values(
				await run(createPrometheusSource(pact.deps), query, Cohort.CANARY),
			),
		).toEqual([0.04, 0.05]);
	});
	it("no matching series is an empty (no data) answer", async () => {
		const pact = pactTransport([
			interaction(prometheus, "range query with no matching series"),
		]);
		expect(
			values(
				await run(createPrometheusSource(pact.deps), query, Cohort.CANARY),
			),
		).toEqual([]);
	});
	it("a 400 is a typed refusal", async () => {
		const pact = pactTransport([
			interaction(prometheus, "range query rejected as a bad request"),
		]);
		expect(
			codes(await run(createPrometheusSource(pact.deps), query, Cohort.CANARY)),
		).toEqual(["health-source-http-error"]);
	});
});

describe("Datadog adapter passes its PACT", () => {
	const query = create(HealthQueryRecordSchema, {
		name: "errors",
		source: HealthSourceKind.DATADOG,
		endpointRef: "https://api.datadoghq.com",
		query: "avg:trace.http.request.errors{env:prod} by {track}",
		cohortLabel: "track",
		credentialRef: "dd",
	});
	it("selects the baseline series by tag and drops null points", async () => {
		const pact = pactTransport([
			interaction(datadog, "timeseries query for the baseline cohort by tag"),
		]);
		expect(
			values(await run(createDatadogSource(pact.deps), query, Cohort.BASELINE)),
		).toEqual([0.1, 0.2]);
	});
	it("a 403 is a typed refusal", async () => {
		const pact = pactTransport([
			interaction(datadog, "timeseries query refused for bad keys"),
		]);
		expect(
			codes(await run(createDatadogSource(pact.deps), query, Cohort.BASELINE)),
		).toEqual(["health-source-http-error"]);
	});
});

describe("New Relic adapter passes its PACT", () => {
	const query = create(HealthQueryRecordSchema, {
		name: "duration",
		source: HealthSourceKind.NEW_RELIC,
		endpointRef: "https://api.newrelic.com/graphql?accountId=1234567",
		query:
			"SELECT average(duration) FROM Transaction FACET track TIMESERIES 1 minute",
		cohortLabel: "track",
		credentialRef: "nr",
	});
	it("sends NRQL as a variable and selects canary rows by the facet attribute, in time order", async () => {
		const pact = pactTransport([
			interaction(newrelic, "faceted timeseries NRQL for the canary cohort"),
		]);
		expect(
			values(await run(createNewRelicSource(pact.deps), query, Cohort.CANARY)),
		).toEqual([0.3, 0.31]);
	});
	it("GraphQL errors are a typed refusal", async () => {
		const pact = pactTransport([
			interaction(
				newrelic,
				"NRQL syntax error reported in the GraphQL errors array",
			),
		]);
		expect(
			codes(await run(createNewRelicSource(pact.deps), query, Cohort.CANARY)),
		).toEqual(["health-source-http-error"]);
	});
	it("authored SINCE/UNTIL is refused before any request", async () => {
		const pact = pactTransport([]);
		const bad = create(HealthQueryRecordSchema, {
			...query,
			query: `${query.query} SINCE 1 hour ago`,
		});
		expect(
			codes(await run(createNewRelicSource(pact.deps), bad, Cohort.CANARY)),
		).toEqual(["health-source-query-invalid"]);
		expect(pact.served()).toBe(0);
	});
});

describe("CloudWatch adapter passes its PACT", () => {
	const query = create(HealthQueryRecordSchema, {
		name: "5xx",
		source: HealthSourceKind.CLOUDWATCH,
		endpointRef: "https://monitoring.eu-west-1.amazonaws.com",
		query: JSON.stringify({
			namespace: "AWS/ApplicationELB",
			metricName: "HTTPCode_Target_5XX_Count",
			stat: "Sum",
			period: 60,
			dimensions: { LoadBalancer: "app/web/123" },
		}),
		cohortLabel: "track",
		credentialRef: "aws",
	});
	it("signs with SigV4, adds the cohort dimension and follows NextToken", async () => {
		const pact = pactTransport([
			interaction(
				cloudwatch,
				"GetMetricData for the canary cohort as a dimension, two pages",
			),
			interaction(cloudwatch, "GetMetricData second page"),
		]);
		expect(
			values(
				await run(createCloudWatchSource(pact.deps), query, Cohort.CANARY),
			),
		).toEqual([3, 1, 0]);
		expect(pact.served()).toBe(2);
	});
	it("an expired token is a typed refusal", async () => {
		const pact = pactTransport([
			interaction(cloudwatch, "GetMetricData refused for an expired token"),
		]);
		expect(
			codes(await run(createCloudWatchSource(pact.deps), query, Cohort.CANARY)),
		).toEqual(["health-source-http-error"]);
	});
	it("a non-regional endpoint is refused before any request", async () => {
		const pact = pactTransport([]);
		const bad = create(HealthQueryRecordSchema, {
			...query,
			endpointRef: "https://evil.example.com",
		});
		expect(
			codes(await run(createCloudWatchSource(pact.deps), bad, Cohort.CANARY)),
		).toEqual(["health-source-endpoint-invalid"]);
	});
});

describe("HTTP JSON source passes its PACT", () => {
	const query = create(HealthQueryRecordSchema, {
		name: "latency",
		source: HealthSourceKind.HTTP_JSON,
		endpointRef: "https://health.example.com/health/latency?region=eu",
		query: "/data/p95",
		cohortLabel: "track",
	});
	it("reads the numeric array at the JSON pointer, keeping the endpoint's own parameters", async () => {
		const pact = pactTransport([
			interaction(httpJson, "series for the canary cohort at a JSON pointer"),
		]);
		expect(
			values(await run(createHttpJsonSource(pact.deps), query, Cohort.CANARY)),
		).toEqual([120, 131.5, 128]);
	});
	it("a pointer at a non-array is a typed refusal", async () => {
		const pact = pactTransport([
			interaction(httpJson, "pointer target that is not an array"),
		]);
		expect(
			codes(await run(createHttpJsonSource(pact.deps), query, Cohort.ALL)),
		).toEqual(["health-source-response-invalid"]);
	});
});

describe("HoBo metering source passes its PACT", () => {
	const query = create(HealthQueryRecordSchema, {
		name: "error-ratio",
		source: HealthSourceKind.HOBO_METERING,
		endpointRef: "https://station.example.com/station",
		query: "requests.error_ratio",
		cohortLabel: "track",
		credentialRef: "station",
	});
	it("reads the series for the baseline cohort in time order", async () => {
		const pact = pactTransport([
			interaction(
				hoboMetering,
				"metered series for one Camp and the baseline cohort",
			),
		]);
		expect(
			values(
				await run(createHoboMeteringSource(pact.deps), query, Cohort.BASELINE),
			),
		).toEqual([0.01, 0.03]);
	});
	it("a 503 is a typed refusal", async () => {
		const pact = pactTransport([
			interaction(hoboMetering, "metering unavailable"),
		]);
		expect(
			codes(
				await run(createHoboMeteringSource(pact.deps), query, Cohort.BASELINE),
			),
		).toEqual(["health-source-http-error"]);
	});
});
