// OpenAPI 3.1 description of the CD read API (WP12). The PACT in
// packages/control-api/contracts/pacts/control-api-cd.pact.json is checked
// against this document (every interaction's path, parameters and response
// body must match), so the two cannot drift. Record payloads are canonical
// protobuf JSON of the frozen `hobo.cd.v1` messages (cd.proto).

type Schema = Readonly<Record<string, unknown>>;

const obj = (
	required: readonly string[],
	properties: Readonly<Record<string, Schema>>,
	description?: string,
): Schema => ({
	type: "object",
	required: [...required],
	properties,
	...(description ? { description } : {}),
});
const str: Schema = { type: "string" };
const strings: Schema = { type: "array", items: str };
const bool: Schema = { type: "boolean" };
const record = (message: string, required: readonly string[] = []): Schema =>
	obj(
		required,
		{},
		`hobo.cd.v1.${message} as canonical protobuf JSON (camelCase, enum names, 64-bit integers as strings)`,
	);
const arrayOf = (items: Schema): Schema => ({ type: "array", items });
const ref = (name: string): Schema => ({
	$ref: `#/components/schemas/${name}`,
});

export const CD_API_SCHEMAS = Object.freeze({
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

export type CdApiSchemaName = keyof typeof CD_API_SCHEMAS;

const ok = (value: CdApiSchemaName): Schema => ({
	description: "ok",
	content: {
		"application/json": {
			schema: obj(["ok", "value"], { ok: { const: true }, value: ref(value) }),
		},
	},
});
const refused = (description: string): Schema => ({
	description,
	content: { "application/json": { schema: ref("Refusal") } },
});
const q = (name: string, description: string, required = false): Schema => ({
	name,
	in: "query",
	required,
	schema: str,
	description,
});
const p = (name: string, description: string): Schema => ({
	name,
	in: "path",
	required: true,
	schema: str,
	description,
});
const get = (
	summary: string,
	value: CdApiSchemaName,
	parameters: readonly Schema[] = [],
	notFound = false,
): Schema => ({
	get: {
		summary,
		parameters: [...parameters],
		responses: {
			"200": ok(value),
			"400": refused("query-invalid"),
			...(notFound ? { "404": refused("not-found") } : {}),
			"503": refused("store-unavailable"),
		},
	},
});

export function cdOpenApi(): Readonly<Record<string, unknown>> {
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
			"/v1/cd/pipelines/{name}": get(
				"Pipeline graph with per-node current Freight and availability",
				"PipelineView",
				[p("name", "pipeline name")],
				true,
			),
			"/v1/cd/freight/{id}": get(
				"Freight timeline across Camps",
				"FreightTimeline",
				[p("id", "Freight id (sha256:…) or alias")],
				true,
			),
			"/v1/cd/promotions": get("Promotions, newest first", "PromotionList", [
				q("camp", "target Camp id"),
				q("limit", "1–1000, default 100"),
			]),
			"/v1/cd/camps": get("Camp inventory", "CampList", [
				q("set", "Camp set name"),
				q("taint", "NO_PLACE | NO_RUN | taint key"),
				q(
					"condition",
					"READY | REACHABLE | LEASED | CREDENTIAL_VALID | CLAIMS_CONSISTENT | POSTURE_COMPLIANT, optionally =true|false|unknown",
				),
			]),
			"/v1/cd/camps/{id}/status": get(
				"Desired Set, last reconcile observation and inventory status",
				"CampStatusView",
				[p("id", "Camp id")],
				true,
			),
			"/v1/cd/camps/{id}/inventory": get(
				"Declared topology and observed status",
				"CampInventoryView",
				[p("id", "Camp id")],
				true,
			),
			"/v1/cd/placements/{name}/decisions/{id}": get(
				"A recorded placement decision",
				"PlacementDecisionView",
				[p("name", "placement name"), p("id", "decision id")],
				true,
			),
			"/v1/cd/fanouts/{id}": get(
				"Fan-out status",
				"FanoutView",
				[p("id", "fan-out id")],
				true,
			),
			"/v1/cd/failovers": get("Failovers, most recent first", "FailoverList", [
				q("state", "PROPOSED | REPLACING | … | ABANDONED"),
			]),
			"/v1/cd/compliance": get("Compliance records", "ComplianceList", [
				q("camp", "Camp id"),
				q("rail", "Rail digest sha256:…"),
			]),
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
						q("after", "decimal journal position (when headers cannot be set)"),
						q("types", "comma-separated event types"),
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
		components: { schemas: CD_API_SCHEMAS },
	};
}
