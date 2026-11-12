// Built-in health sources (D9): Prometheus, HoBo metering, HTTP JSON and, when
// a posture reader is wired, HoBo posture; adapters for Datadog, New Relic and
// CloudWatch. Vendor names live only here and in verification/sources (I11).
import type { HttpTransport } from "@hobo/core";
import type {
	CredentialResolver,
	HealthSource,
	PostureSeriesReader,
} from "../../ports.js";
import { createCloudWatchSource } from "./cloudwatch.js";
import { createDatadogSource } from "./datadog.js";
import { createHoboMeteringSource } from "./hobo-metering.js";
import { createHoboPostureSource } from "./hobo-posture.js";
import { createHttpJsonSource } from "./http-json.js";
import { createNewRelicSource } from "./newrelic.js";
import { createPrometheusSource } from "./prometheus.js";

export function createHealthSources(
	d: Readonly<{
		http: HttpTransport;
		credentials: CredentialResolver;
		posture?: PostureSeriesReader;
	}>,
): readonly HealthSource[] {
	const deps = { http: d.http, credentials: d.credentials };
	const sources = [
		createPrometheusSource(deps),
		createHoboMeteringSource(deps),
		createHttpJsonSource(deps),
		createDatadogSource(deps),
		createNewRelicSource(deps),
		createCloudWatchSource(deps),
	];
	return d.posture ? [...sources, createHoboPostureSource(d.posture)] : sources;
}

export { CLOUDWATCH_TARGET, createCloudWatchSource } from "./cloudwatch.js";
export { createDatadogSource } from "./datadog.js";
export {
	createHoboMeteringSource,
	METERING_SERIES_PATH,
} from "./hobo-metering.js";
export {
	createHoboPostureSource,
	informVerificationSpec,
	POSTURE_SERIES,
} from "./hobo-posture.js";
export { cohortValue, credentialScope, type SourceDeps } from "./http.js";
export { createHttpJsonSource, resolvePointer } from "./http-json.js";
export { createNewRelicSource, NERDGRAPH_NRQL_DOCUMENT } from "./newrelic.js";
export { createPrometheusSource, prometheusStepSeconds } from "./prometheus.js";
export { type AwsCredentials, signV4 } from "./sigv4.js";
