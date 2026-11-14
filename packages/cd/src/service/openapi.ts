// OpenAPI 3.1 description of the CD read API (WP12). The PACT in
// packages/control-api/contracts/pacts/control-api-cd.pact.json is checked
// against this document (every interaction's path, parameters and response
// body must match), so the two cannot drift. Record payloads are canonical
// protobuf JSON of the frozen `hobo.cd.v1` messages (cd.proto).
import type { JsonObject } from "@hobo/core";

/** A JSON Schema (OpenAPI 3.1 dialect) node. */
export type CdApiSchema = JsonObject;

/** The OpenAPI document; plain JSON so it can be served and merged as-is. */
export type CdOpenApiDocument = JsonObject;

function obj(
	required: readonly string[],
	properties: Readonly<Record<string, CdApiSchema>>,
): CdApiSchema {
	return { type: "object", required: [...required], properties };
}

function described(schema: CdApiSchema, description: string): CdApiSchema {
	return { ...schema, description };
}

const str = { type: "string" } satisfies CdApiSchema;
const strings = { type: "array", items: str } satisfies CdApiSchema;
const bool = { type: "boolean" } satisfies CdApiSchema;

function record(
	message: string,
	required: readonly string[] = [],
): CdApiSchema {
	return described(
		obj(required, {}),
		`hobo.cd.v1.${message} as canonical protobuf JSON (camelCase, enum names, 64-bit integers as strings)`,
	);
}

function arrayOf(items: CdApiSchema): CdApiSchema {
	return { type: "array", items };
}

function ref(name: CdApiSchemaName): CdApiSchema {
	return { $ref: `#/components/schemas/${name}` };
}

type CdApiSchemaName =
	| "Reason"
	| "Refusal"
	| "CampCurrent"
	| "PipelineNodeView"
	| "PipelineView"
	| "TimelineEntry"
	| "FreightTimeline"
	| "PromotionList"
	| "CampStatusView"
	| "CampTopology"
	| "CampList"
	| "CampInventoryView"
	| "PlacementDecisionView"
	| "FanoutView"
	| "FailoverList"
	| "ComplianceList"
	| "HealthReport"
	| "StreamFrame";

export const CD_API_SCHEMAS: Readonly<Record<CdApiSchemaName, CdApiSchema>> =
	Object.freeze({
		Reason: obj(["code", "message", "remediation", "subject"], {
			code: str,
			message: str,
			remediation: str,
			subject: str,
		}),
		Refusal: obj(["ok", "reasons"], {
			ok: { const: false },
			reasons: arrayOf(ref("Reason")),
		}),
		CampCurrent: obj(["campId"], { campId: str, freightId: str, setId: str }),
		PipelineNodeView: obj(["name", "edges", "camps", "available"], {
			name: str,
			edges: obj(["fromSources", "fromNodes"], {
				fromSources: strings,
				fromNodes: strings,
			}),
			placement: str,
			decisionId: str,
			qualified: obj(["campIds"], { campIds: strings, freightId: str }),
			camps: arrayOf(ref("CampCurrent")),
			available: arrayOf(record("FreightAvailabilityRecord", ["freightId"])),
		}),
		PipelineView: obj(["pipeline", "nodes"], {
			pipeline: record("PipelineRecord", ["name"]),
			nodes: arrayOf(ref("PipelineNodeView")),
		}),
		TimelineEntry: obj(["at", "kind", "detail"], {
			at: str,
			kind: {
				type: "string",
				enum: [
					"recorded",
					"promotion",
					"qualified",
					"approved",
					"yanked",
					"retired",
				],
			},
			campId: str,
			detail: { type: "object" },
		}),
		FreightTimeline: obj(["freight", "camps", "timeline"], {
			freight: record("FreightRecord", ["freightId"]),
			camps: strings,
			timeline: arrayOf(ref("TimelineEntry")),
		}),
		PromotionList: obj(["promotions"], {
			promotions: arrayOf(record("PromotionRecord", ["promotionId"])),
		}),
		CampStatusView: obj(["campId"], {
			campId: str,
			current: record("SetRecord"),
			observation: record("ReconcileObservationRecord"),
			inventory: record("CampStatusRecord"),
		}),
		CampTopology: obj(
			[
				"campId",
				"yardId",
				"stationId",
				"provider",
				"regions",
				"envType",
				"labels",
				"management",
			],
			{
				campId: str,
				yardId: str,
				stationId: str,
				provider: str,
				regions: strings,
				envType: str,
				labels: { type: "object" },
				management: { type: "integer" },
			},
		),
		CampList: obj(["camps"], {
			camps: arrayOf(
				obj(["topology", "status"], {
					topology: ref("CampTopology"),
					status: record("CampStatusRecord"),
				}),
			),
		}),
		CampInventoryView: obj(["campId"], {
			campId: str,
			topology: ref("CampTopology"),
			status: record("CampStatusRecord"),
		}),
		PlacementDecisionView: obj(["decision"], {
			decision: record("PlacementDecisionRecord", ["decisionId", "placement"]),
		}),
		FanoutView: obj(["fanout"], {
			fanout: record("FanoutStatusRecord", ["fanoutId"]),
		}),
		FailoverList: obj(["failovers"], {
			failovers: arrayOf(record("FailoverRecord", ["failoverId"])),
		}),
		ComplianceList: obj(["compliance"], {
			compliance: arrayOf(record("ComplianceRecord", ["campId"])),
		}),
		HealthReport: obj(["ok", "checks"], {
			ok: bool,
			checks: arrayOf(
				obj(["name", "ok", "detail"], { name: str, ok: bool, detail: str }),
			),
		}),
		StreamFrame: obj(["position", "streamId", "type", "ts"], {
			position: str,
			streamId: str,
			type: str,
			ts: str,
			data: {},
		}),
	});

function ok(value: CdApiSchemaName): CdApiSchema {
	return {
		description: "ok",
		content: {
			"application/json": {
				schema: obj(["ok", "value"], {
					ok: { const: true },
					value: ref(value),
				}),
			},
		},
	};
}

function refused(description: string): CdApiSchema {
	return {
		description,
		content: { "application/json": { schema: ref("Refusal") } },
	};
}

function query(name: string, description: string): CdApiSchema {
	return { name, in: "query", required: false, schema: str, description };
}

function pathParam(name: string, description: string): CdApiSchema {
	return { name, in: "path", required: true, schema: str, description };
}

function getOperation(
	summary: string,
	value: CdApiSchemaName,
	parameters: readonly CdApiSchema[],
	notFound: boolean,
): CdApiSchema {
	const responses = {
		"200": ok(value),
		"400": refused("query-invalid"),
		"503": refused("store-unavailable"),
	};
	const withNotFound = notFound
		? { ...responses, "404": refused("not-found") }
		: responses;
	return {
		get: { summary, parameters: [...parameters], responses: withNotFound },
	};
}

export function cdOpenApi(): CdOpenApiDocument {
	return {
		openapi: "3.1.0",
		info: {
			title: "HoBo CD read API",
			version: "0.1.0",
			description:
				"Read-only views and the SSE fact stream of @hobo/cd, mounted under /v1/cd/ by @hobo/control-api beside the delivery feed. Envelope: {ok:true,value} | {ok:false,reasons}.",
		},
		paths: {
			"/v1/cd/openapi.json": {
				get: {
					summary: "This document",
					responses: { "200": { description: "OpenAPI 3.1 document" } },
				},
			},
			"/v1/cd/ready": {
				get: {
					summary: "Service readiness: store, reconciler leases, source health",
					responses: { "200": ok("HealthReport"), "503": refused("not-ready") },
				},
			},
			"/v1/cd/pipelines/{name}": getOperation(
				"Pipeline graph with per-node current Freight and availability",
				"PipelineView",
				[pathParam("name", "pipeline name")],
				true,
			),
			"/v1/cd/freight/{id}": getOperation(
				"Freight timeline across Camps",
				"FreightTimeline",
				[pathParam("id", "Freight id (sha256:…) or alias")],
				true,
			),
			"/v1/cd/promotions": getOperation(
				"Promotions, newest first",
				"PromotionList",
				[
					query("camp", "target Camp id"),
					query("limit", "1–1000, default 100"),
				],
				false,
			),
			"/v1/cd/camps": getOperation(
				"Camp inventory",
				"CampList",
				[
					query("set", "Camp set name"),
					query("taint", "NO_PLACE | NO_RUN | taint key"),
					query(
						"condition",
						"READY | REACHABLE | LEASED | CREDENTIAL_VALID | CLAIMS_CONSISTENT | POSTURE_COMPLIANT, optionally =true|false|unknown",
					),
				],
				false,
			),
			"/v1/cd/camps/{id}/status": getOperation(
				"Desired Set, last reconcile observation and inventory status",
				"CampStatusView",
				[pathParam("id", "Camp id")],
				true,
			),
			"/v1/cd/camps/{id}/inventory": getOperation(
				"Declared topology and observed status",
				"CampInventoryView",
				[pathParam("id", "Camp id")],
				true,
			),
			"/v1/cd/placements/{name}/decisions/{id}": getOperation(
				"A recorded placement decision",
				"PlacementDecisionView",
				[pathParam("name", "placement name"), pathParam("id", "decision id")],
				true,
			),
			"/v1/cd/fanouts/{id}": getOperation(
				"Fan-out status",
				"FanoutView",
				[pathParam("id", "fan-out id")],
				true,
			),
			"/v1/cd/failovers": getOperation(
				"Failovers, most recent first",
				"FailoverList",
				[query("state", "PROPOSED | REPLACING | … | ABANDONED")],
				false,
			),
			"/v1/cd/compliance": getOperation(
				"Compliance records",
				"ComplianceList",
				[query("camp", "Camp id"), query("rail", "Rail digest sha256:…")],
				false,
			),
			"/v1/cd/stream": {
				get: {
					summary:
						"SSE stream of every @hobo/cd journal fact; resume with Last-Event-ID",
					parameters: [
						{
							name: "Last-Event-ID",
							in: "header",
							required: false,
							schema: str,
							description: "decimal journal position",
						},
						query(
							"after",
							"decimal journal position (when headers cannot be set)",
						),
						query("types", "comma-separated event types"),
					],
					responses: {
						"200": {
							description:
								"text/event-stream of `id: <position>` / `event: <type>` / `data: StreamFrame`, ending with `event: end`",
							content: { "text/event-stream": { schema: ref("StreamFrame") } },
						},
						"400": refused("last-event-id-invalid"),
					},
				},
			},
		},
		components: { schemas: { ...CD_API_SCHEMAS } },
	};
}
