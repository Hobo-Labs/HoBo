// CloudWatch adapter: GetMetricData over the AWS JSON 1.0 protocol, signed
// with SigV4 (no SDK). endpoint_ref is the regional monitoring endpoint
// (https://monitoring.<region>.amazonaws.com); the credential resolves to
// { accessKeyId, secretAccessKey, sessionToken? }. The query is a JSON metric
// stat; the cohort is an extra dimension `<cohort_label>=canary|baseline`:
//
//   {"namespace":"AWS/ApplicationELB","metricName":"HTTPCode_Target_5XX_Count",
//    "stat":"Sum","period":60,"dimensions":{"LoadBalancer":"app/web/123"}}
import { HealthSourceKind } from "../../_generated/cd_pb.js";
import type { HealthSource } from "../../ports.js";
import { refuse } from "../reasons.js";
import {
	cohortSelector,
	credentialFor,
	httpsEndpoint,
	invalid,
	isRecord,
	requestJson,
	type SourceDeps,
	sampleValue,
	samplesOutcome,
} from "./http.js";
import { signV4 } from "./sigv4.js";

export const CLOUDWATCH_TARGET = "GraniteServiceVersion20100801.GetMetricData";
const REGIONAL_HOST = /^monitoring\.([a-z]{2}(?:-[a-z]+)+-\d)\.amazonaws\.com(?:\.cn)?$/;
const MAX_PAGES = 10;

type MetricStat = Readonly<{ namespace: string; metricName: string; stat: string; period: number; dimensions: Readonly<Record<string, string>> }>;

function parseMetricStat(text: string): MetricStat | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(value)) return undefined;
	const { namespace, metricName, stat, period, dimensions } = value;
	if (typeof namespace !== "string" || typeof metricName !== "string" || typeof stat !== "string") return undefined;
	if (typeof period !== "number" || !Number.isInteger(period) || period < 1) return undefined;
	const dims: Record<string, string> = {};
	if (dimensions !== undefined) {
		if (!isRecord(dimensions)) return undefined;
		for (const [name, dim] of Object.entries(dimensions)) {
			if (typeof dim !== "string") return undefined;
			dims[name] = dim;
		}
	}
	return { namespace, metricName, stat, period, dimensions: dims };
}

export function createCloudWatchSource(deps: SourceDeps): HealthSource {
	return {
		kind: HealthSourceKind.CLOUDWATCH,
		async query(input, ctx) {
			const { query } = input;
			const endpoint = httpsEndpoint(query);
			if (!endpoint.ok) return endpoint;
			const region = REGIONAL_HOST.exec(endpoint.value.host)?.[1];
			if (!region) return refuse("health-source-endpoint-invalid", `${query.name}: endpoint_ref must be https://monitoring.<region>.amazonaws.com`, query.name);
			const stat = parseMetricStat(query.query);
			if (!stat) return refuse("health-source-query-invalid", `${query.name}: query must be a JSON metric stat`, query.name);
			const selector = cohortSelector(query, input.cohort);
			if (!selector.ok) return selector;
			const credential = await credentialFor(deps, query, input.campId);
			if (!credential.ok) return credential;
			const { accessKeyId, secretAccessKey, sessionToken } = credential.value;
			if (!accessKeyId || !secretAccessKey) {
				return refuse("health-source-credential-unavailable", `${query.name}: credential must hold accessKeyId and secretAccessKey`, query.name);
			}
			const dimensions = Object.entries(stat.dimensions)
				.sort(([a], [b]) => (a < b ? -1 : 1))
				.map(([Name, Value]) => ({ Name, Value }));
			if (selector.value) dimensions.push({ Name: selector.value.label, Value: selector.value.value });
			const url = new URL("/", endpoint.value);
			const values: number[] = [];
			let nextToken: string | undefined;
			for (let page = 0; page < MAX_PAGES; page += 1) {
				const request: Record<string, unknown> = {
					MetricDataQueries: [
						{
							Id: "q0",
							MetricStat: { Metric: { Namespace: stat.namespace, MetricName: stat.metricName, Dimensions: dimensions }, Period: stat.period, Stat: stat.stat },
							ReturnData: true,
						},
					],
					StartTime: Math.floor(input.fromMs / 1000),
					EndTime: Math.floor(input.toMs / 1000),
					ScanBy: "TimestampAscending",
				};
				if (nextToken) request.NextToken = nextToken;
				const body = JSON.stringify(request);
				const headers = signV4({
					method: "POST",
					url: url.toString(),
					headers: { accept: "application/json", "content-type": "application/x-amz-json-1.0", "x-amz-target": CLOUDWATCH_TARGET },
					body,
					region,
					service: "monitoring",
					credentials: sessionToken ? { accessKeyId, secretAccessKey, sessionToken } : { accessKeyId, secretAccessKey },
					atMs: ctx.now(),
				});
				const response = await requestJson(deps, { method: "POST", url, headers, body, subject: query.name });
				if (!response.ok) return response;
				const answer = response.value;
				if (!isRecord(answer) || !Array.isArray(answer.MetricDataResults)) return invalid(query.name, "CloudWatch answer has no MetricDataResults");
				for (const result of answer.MetricDataResults) {
					if (!isRecord(result) || !Array.isArray(result.Values)) return invalid(query.name, "malformed MetricDataResult");
					if (result.StatusCode === "Forbidden" || result.StatusCode === "InternalError") {
						return refuse("health-source-http-error", `CloudWatch status ${String(result.StatusCode)}`, query.name);
					}
					for (const raw of result.Values) {
						const value = sampleValue(raw);
						if (value !== undefined) values.push(value);
					}
				}
				nextToken = typeof answer.NextToken === "string" && answer.NextToken !== "" ? answer.NextToken : undefined;
				if (!nextToken) return samplesOutcome(values, input.fromMs, input.toMs);
			}
			return refuse("health-source-response-invalid", `${query.name}: more than ${MAX_PAGES} pages of data; narrow the period`, query.name);
		},
	};
}
