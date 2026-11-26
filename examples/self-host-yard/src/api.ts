import { create, toJson } from "@bufbuild/protobuf";

import {
	ComponentStatusSchema,
	Health,
	IncidentAckSchema,
	type IncidentReport,
	IncidentReportSchema,
	StatusPageSchema,
} from "./_generated/status_pb.js";

/**
 * The components the status page reports on — the self-hosted Yard's own
 * moving parts. Seeded operational; an accepted incident report degrades one.
 */
const components = new Map<string, { health: Health; note: string }>([
	["yard-control-plane", { health: Health.OPERATIONAL, note: "" }],
	["event-store", { health: Health.OPERATIONAL, note: "" }],
	["status-api", { health: Health.OPERATIONAL, note: "" }],
]);

/**
 * The single parse boundary: untrusted incident JSON → a derived
 * {@link IncidentReport} message generated from `data-models/status.proto`
 * (parse, don't validate). Downstream code never re-checks raw fields — it
 * either holds a parsed `IncidentReport` or the boundary refused with a
 * `TypeError`.
 */
type JsonObject = { readonly [key: string]: JsonValue };
type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| JsonObject;

function isJsonObject(value: JsonValue): value is JsonObject {
	return (
		value !== null &&
		!Array.isArray(value) &&
		Object.prototype.toString.call(value) === "[object Object]"
	);
}

function isJsonString(value: JsonValue | undefined): value is string {
	return Object.prototype.toString.call(value) === "[object String]";
}

export function parseIncidentReport(raw: JsonValue): IncidentReport {
	if (!isJsonObject(raw)) {
		throw new TypeError("incident body must be a JSON object");
	}
	const component = raw.component;
	const note = raw.note;
	if (!isJsonString(component) || component.trim().length === 0) {
		throw new TypeError("incident component must be a non-empty string");
	}
	if (!isJsonString(note) || note.trim().length === 0) {
		throw new TypeError("incident note must be a non-empty string");
	}
	return create(IncidentReportSchema, {
		component: component.trim(),
		note: note.trim(),
	});
}

let incidentCounter = 0;

/**
 * The status-page API: a plain fetch handler (no framework) exposing
 * `GET /status` and `POST /incidents`.
 */
export async function statusApi(request: Request): Promise<Response> {
	const url = new URL(request.url);

	if (request.method === "GET" && url.pathname === "/status") {
		const page = create(StatusPageSchema, {
			components: [...components.entries()].map(([component, state]) =>
				create(ComponentStatusSchema, {
					component,
					health: state.health,
					note: state.note,
				}),
			),
		});
		return Response.json(toJson(StatusPageSchema, page));
	}

	if (request.method === "POST" && url.pathname === "/incidents") {
		let incident: IncidentReport;
		try {
			const body = await request.json();
			// SAFETY: request JSON is untyped; parseIncidentReport is the boundary.
			incident = parseIncidentReport(body as JsonValue);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return Response.json({ error: message }, { status: 400 });
		}
		const tracked = components.get(incident.component);
		if (!tracked) {
			return Response.json(
				{ error: `unknown component ${incident.component}` },
				{ status: 404 },
			);
		}
		tracked.health = Health.DEGRADED;
		tracked.note = incident.note;
		incidentCounter += 1;
		const ack = create(IncidentAckSchema, {
			incidentId: `incident-${incidentCounter}`,
			component: incident.component,
			note: incident.note,
		});
		return Response.json(toJson(IncidentAckSchema, ack), { status: 202 });
	}

	return Response.json({ error: "not found" }, { status: 404 });
}
