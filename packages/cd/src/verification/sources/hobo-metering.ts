// HoBo metering health source: reads a metered series from a Station's
// metering read API, GET <endpoint_ref>/v1/metering/series. The query names
// the meter; the Camp, window and cohort travel as parameters; the answer is
// `{ "series": [{ "atMs": <epoch ms>, "value": <number|null> }] }`, ordered by
// the source and re-sorted here by time. The contract is pinned by
// test/verification/pacts/hobo-metering.pact.json.

import { HealthSourceKind } from "../../_generated/cd_pb.js";
import type { HealthSource } from "../../ports.js";
import { isJsonArray, isJsonNumber, isJsonObject } from "../json.js";
import {
	cohortSelector,
	credentialFor,
	httpsEndpoint,
	invalid,
	requestJson,
	type SourceDeps,
	samplesOutcome,
	sampleValue,
} from "./http.js";

// public-contract: Station metering read API series path this source calls;
// pinned by the hobo-metering PACT.
export const METERING_SERIES_PATH = "/v1/metering/series";

export function createHoboMeteringSource(deps: SourceDeps): HealthSource {
	return {
		kind: HealthSourceKind.HOBO_METERING,
		async query(input) {
			const { query } = input;
			const endpoint = httpsEndpoint(query);
			if (!endpoint.ok) return endpoint;
			const selector = cohortSelector(query, input.cohort);
			if (!selector.ok) return selector;
			const credential = await credentialFor(deps, query, input.campId);
			if (!credential.ok) return credential;
			const url = new URL(
				`${endpoint.value.pathname.replace(/\/$/, "")}${METERING_SERIES_PATH}`,
				endpoint.value,
			);
			url.searchParams.set("meter", query.query);
			url.searchParams.set("camp", input.campId);
			url.searchParams.set("from", String(input.fromMs));
			url.searchParams.set("to", String(input.toMs));
			if (selector.value) url.searchParams.set("cohort", selector.value.value);
			const response = await requestJson(deps, {
				method: "GET",
				url,
				headers: credential.value,
				subject: query.name,
			});
			if (!response.ok) return response;
			const body = response.value;
			if (!isJsonObject(body) || !isJsonArray(body.series))
				return invalid(query.name, "metering answer has no series");
			const points: Array<Readonly<{ atMs: number; value: number }>> = [];
			for (const point of body.series) {
				if (!isJsonObject(point) || !isJsonNumber(point.atMs))
					return invalid(query.name, "malformed metering point");
				const value = sampleValue(point.value);
				if (value !== undefined) points.push({ atMs: point.atMs, value });
			}
			points.sort((a, b) => a.atMs - b.atMs);
			return samplesOutcome(
				points.map((point) => point.value),
				input.fromMs,
				input.toMs,
			);
		},
	};
}
