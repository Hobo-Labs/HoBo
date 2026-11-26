// Datadog metrics adapter: GET /api/v1/query (timeseries) on the site in
// endpoint_ref (api.datadoghq.com, api.datadoghq.eu, ...). The credential
// resolves to the DD-API-KEY / DD-APPLICATION-KEY headers. The cohort is the
// series whose tag_set holds `<cohort_label>:canary|baseline`, so the query
// must group by that tag, e.g. `avg:trace.http.request.errors{env:prod} by {track}`.

import { HealthSourceKind } from "../../_generated/cd_pb.js";
import type { HealthSource } from "../../ports.js";
import { isJsonArray, isJsonObject, isJsonString } from "../json.js";
import {
	byKey,
	cohortSelector,
	credentialFor,
	httpsEndpoint,
	invalid,
	requestJson,
	type SourceDeps,
	samplesOutcome,
	sampleValue,
} from "./http.js";

export function createDatadogSource(deps: SourceDeps): HealthSource {
	return {
		kind: HealthSourceKind.DATADOG,
		async query(input) {
			const { query } = input;
			const endpoint = httpsEndpoint(query);
			if (!endpoint.ok) return endpoint;
			const selector = cohortSelector(query, input.cohort);
			if (!selector.ok) return selector;
			const credential = await credentialFor(deps, query, input.campId);
			if (!credential.ok) return credential;
			const url = new URL("/api/v1/query", endpoint.value);
			url.searchParams.set("from", String(Math.floor(input.fromMs / 1000)));
			url.searchParams.set("to", String(Math.floor(input.toMs / 1000)));
			url.searchParams.set("query", query.query);
			const response = await requestJson(deps, {
				method: "GET",
				url,
				headers: credential.value,
				subject: query.name,
			});
			if (!response.ok) return response;
			const body = response.value;
			if (
				!isJsonObject(body) ||
				body.status !== "ok" ||
				!isJsonArray(body.series)
			)
				return invalid(query.name, "Datadog answer has no series");
			const wanted = selector.value
				? `${selector.value.label}:${selector.value.value}`
				: undefined;
			const series: Array<Readonly<{ key: string; values: number[] }>> = [];
			for (const item of body.series) {
				if (!isJsonObject(item) || !isJsonArray(item.pointlist))
					return invalid(query.name, "malformed Datadog series");
				const tags = isJsonArray(item.tag_set)
					? item.tag_set.filter(isJsonString)
					: [];
				if (wanted && !tags.includes(wanted)) continue;
				const values: number[] = [];
				for (const point of item.pointlist) {
					if (!isJsonArray(point) || point.length !== 2)
						return invalid(query.name, "malformed Datadog point");
					const value = sampleValue(point[1]);
					if (value !== undefined) values.push(value);
				}
				series.push({ key: [...tags].sort().join(","), values });
			}
			series.sort(byKey);
			return samplesOutcome(
				series.flatMap((item) => item.values),
				input.fromMs,
				input.toMs,
			);
		},
	};
}
