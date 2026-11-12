// New Relic adapter: NRQL through NerdGraph (POST /graphql). endpoint_ref is
// the NerdGraph URL with the account as `?accountId=<n>` (stripped before the
// call). The credential resolves to the `API-Key` header. The window is
// appended as `SINCE <ms> UNTIL <ms>`, so the authored NRQL must not carry its
// own; NRQL travels as a GraphQL variable, never spliced into the document.
// The cohort is selected from FACET rows by the declared attribute, so the
// query must `FACET <cohort_label> TIMESERIES` and return one aggregate.

import { HealthSourceKind } from "../../_generated/cd_pb.js";
import type { HealthSource } from "../../ports.js";
import {
	isJsonArray,
	isJsonNumber,
	isJsonObject,
	isJsonString,
} from "../json.js";
import { refuse } from "../reasons.js";
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

export const NERDGRAPH_NRQL_DOCUMENT =
	"query($accountId: Int!, $nrql: Nrql!) { actor { account(id: $accountId) { nrql(query: $nrql) { results } } } }";

const TIME_KEYS = new Set(["beginTimeSeconds", "endTimeSeconds", "facet"]);

export function createNewRelicSource(deps: SourceDeps): HealthSource {
	return {
		kind: HealthSourceKind.NEW_RELIC,
		async query(input) {
			const { query } = input;
			const endpoint = httpsEndpoint(query);
			if (!endpoint.ok) return endpoint;
			const accountId = Number(endpoint.value.searchParams.get("accountId"));
			if (!Number.isSafeInteger(accountId) || accountId <= 0) {
				return refuse(
					"health-source-endpoint-invalid",
					`endpoint_ref of ${query.name} needs ?accountId=<number>`,
					query.name,
				);
			}
			if (/\b(SINCE|UNTIL)\b/i.test(query.query)) {
				return refuse(
					"health-source-query-invalid",
					`${query.name}: the engine sets SINCE/UNTIL from the window`,
					query.name,
				);
			}
			const selector = cohortSelector(query, input.cohort);
			if (!selector.ok) return selector;
			const credential = await credentialFor(deps, query, input.campId);
			if (!credential.ok) return credential;
			const url = new URL(endpoint.value.pathname, endpoint.value);
			const nrql = `${query.query} SINCE ${Math.floor(input.fromMs)} UNTIL ${Math.floor(input.toMs)}`;
			const response = await requestJson(deps, {
				method: "POST",
				url,
				headers: { ...credential.value, "content-type": "application/json" },
				body: JSON.stringify({
					query: NERDGRAPH_NRQL_DOCUMENT,
					variables: { accountId, nrql },
				}),
				subject: query.name,
			});
			if (!response.ok) return response;
			const body = response.value;
			if (
				isJsonObject(body) &&
				isJsonArray(body.errors) &&
				body.errors.length > 0
			) {
				return refuse(
					"health-source-http-error",
					`NerdGraph returned ${body.errors.length} error(s)`,
					query.name,
				);
			}
			const results =
				isJsonObject(body) &&
				isJsonObject(body.data) &&
				isJsonObject(body.data.actor) &&
				isJsonObject(body.data.actor.account) &&
				isJsonObject(body.data.actor.account.nrql)
					? body.data.actor.account.nrql.results
					: undefined;
			if (!isJsonArray(results))
				return invalid(query.name, "NerdGraph answer has no nrql results");
			const rows: Array<Readonly<{ at: number; value: number }>> = [];
			for (const row of results) {
				if (!isJsonObject(row))
					return invalid(query.name, "malformed NRQL row");
				if (selector.value) {
					const facet = row[selector.value.label] ?? row.facet;
					if (facet !== selector.value.value) continue;
				}
				const valueKeys = Object.keys(row).filter(
					(key) =>
						!TIME_KEYS.has(key) &&
						key !== query.cohortLabel &&
						!isJsonString(row[key]),
				);
				if (valueKeys.length !== 1)
					return refuse(
						"health-source-query-invalid",
						`${query.name}: NRQL must return exactly one aggregate per row`,
						query.name,
					);
				const value = sampleValue(row[valueKeys[0] ?? ""]);
				if (value !== undefined)
					rows.push({
						at: isJsonNumber(row.beginTimeSeconds) ? row.beginTimeSeconds : 0,
						value,
					});
			}
			rows.sort((a, b) => a.at - b.at || a.value - b.value);
			return samplesOutcome(
				rows.map((row) => row.value),
				input.fromMs,
				input.toMs,
			);
		},
	};
}
