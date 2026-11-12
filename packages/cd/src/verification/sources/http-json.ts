// Generic HTTP JSON health source: GET endpoint_ref with `from`, `to` (epoch
// ms), `camp` and, for a split cohort, `<cohort_label>=canary|baseline`
// added as query parameters; the query is an RFC 6901 JSON pointer to an
// array of numbers (null entries mean no sample).
import { HealthSourceKind } from "../../_generated/cd_pb.js";
import type { HealthSource } from "../../ports.js";
import { refuse } from "../reasons.js";
import { cohortSelector, credentialFor, httpsEndpoint, invalid, isRecord, requestJson, type SourceDeps, sampleValue, samplesOutcome } from "./http.js";

/** Resolve an RFC 6901 JSON pointer; undefined when any token is missing. */
export function resolvePointer(document: unknown, pointer: string): unknown {
	if (pointer === "") return document;
	if (!pointer.startsWith("/")) return undefined;
	let current: unknown = document;
	for (const raw of pointer.slice(1).split("/")) {
		const token = raw.replace(/~1/g, "/").replace(/~0/g, "~");
		if (Array.isArray(current)) {
			if (!/^(0|[1-9]\d*)$/.test(token)) return undefined;
			current = current[Number(token)];
		} else if (isRecord(current) && Object.hasOwn(current, token)) {
			current = current[token];
		} else {
			return undefined;
		}
	}
	return current;
}

export function createHttpJsonSource(deps: SourceDeps): HealthSource {
	return {
		kind: HealthSourceKind.HTTP_JSON,
		async query(input) {
			const { query } = input;
			if (query.query !== "" && !query.query.startsWith("/")) {
				return refuse("health-source-query-invalid", `${query.name}: query must be a JSON pointer such as /data/values`, query.name);
			}
			const endpoint = httpsEndpoint(query);
			if (!endpoint.ok) return endpoint;
			const selector = cohortSelector(query, input.cohort);
			if (!selector.ok) return selector;
			const credential = await credentialFor(deps, query, input.campId);
			if (!credential.ok) return credential;
			const url = new URL(endpoint.value);
			url.searchParams.set("from", String(input.fromMs));
			url.searchParams.set("to", String(input.toMs));
			url.searchParams.set("camp", input.campId);
			if (selector.value) url.searchParams.set(selector.value.label, selector.value.value);
			const response = await requestJson(deps, { method: "GET", url, headers: credential.value, subject: query.name });
			if (!response.ok) return response;
			const array = resolvePointer(response.value, query.query);
			if (!Array.isArray(array)) return invalid(query.name, `${query.query} does not point at an array`);
			const values: number[] = [];
			for (const item of array) {
				if (item === null) continue;
				if (typeof item !== "number") return invalid(query.name, `${query.query} holds a non-numeric entry`);
				const value = sampleValue(item);
				if (value !== undefined) values.push(value);
			}
			return samplesOutcome(values, input.fromMs, input.toMs);
		},
	};
}
