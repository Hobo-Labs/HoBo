/**
 * Schema-derived generative sheets (OpenUI spirit).
 * Component library is built from management/connection/rail schemas —
 * not free-form LLM chrome. Confirm → pure management functions.
 */

import type {
	ManagementResult,
	YardProjectionSnapshot,
} from "@hobo/management";

export type SheetKind =
	| "connection.create"
	| "connection.authorize"
	| "rail.lifecycle"
	| "cost.plan"
	| "doctor.hazards";

export type SheetField = Readonly<{
	name: string;
	label: string;
	type: "string" | "select" | "number" | "readonly";
	required?: boolean;
	options?: readonly string[];
	value?: string | number;
}>;

export type GenerativeSheet = Readonly<{
	kind: SheetKind;
	title: string;
	description: string;
	fields: readonly SheetField[];
	/** Management path the confirm action must call. */
	confirmOp:
		| "connectionCreate"
		| "connectionAuthorize"
		| "stationRailsPublish"
		| "stationRailsApprove"
		| "stationRailsActivate"
		| "doctorSnapshot";
	streamChunks: readonly string[];
}>;

function field(f: SheetField): SheetField {
	return Object.freeze(f);
}

/** OpenUI-style progressive stream of sheet definition chunks. */
export function* streamSheet(sheet: GenerativeSheet): Generator<{
	type: "chunk" | "done";
	text?: string;
	sheet?: GenerativeSheet;
}> {
	for (const chunk of sheet.streamChunks) {
		yield { type: "chunk", text: chunk };
	}
	yield { type: "done", sheet };
}

export function sheetForConnectionCreate(
	snap?: YardProjectionSnapshot,
): GenerativeSheet {
	return Object.freeze({
		kind: "connection.create" as const,
		title: "Open Connection Bay",
		description:
			"Create a Station-scoped Connection (secretless-first). Same as `hobo connection create`.",
		fields: Object.freeze([
			field({
				name: "provider",
				label: "Provider",
				type: "string",
				required: true,
				value: "asana",
			}),
			field({
				name: "alias",
				label: "Alias",
				type: "string",
				value: "work",
			}),
			field({
				name: "scopes",
				label: "Scopes (comma-separated)",
				type: "string",
				value: "",
			}),
			field({
				name: "stationId",
				label: "Station",
				type: "readonly",
				value: snap?.occupancy.stationId ?? "station:local",
			}),
		]),
		confirmOp: "connectionCreate" as const,
		streamChunks: Object.freeze([
			"Resolving connector schema…",
			"Binding Station isolation…",
			"Rendering connection form…",
		]),
	});
}

export function sheetForConnectionAuthorize(
	connectionIdOrAlias: string,
	snap?: YardProjectionSnapshot,
): GenerativeSheet {
	const conn = snap?.connections.find(
		(c) => c.id === connectionIdOrAlias || c.alias === connectionIdOrAlias,
	);
	return Object.freeze({
		kind: "connection.authorize" as const,
		title: "Authorize Connection",
		description: `Authorize ${connectionIdOrAlias} — same as \`hobo connection authorize\`.`,
		fields: Object.freeze([
			field({
				name: "idOrAlias",
				label: "Connection",
				type: "readonly",
				value: connectionIdOrAlias,
			}),
			field({
				name: "status",
				label: "Current status",
				type: "readonly",
				value: conn ? String(conn.status) : "unknown",
			}),
		]),
		confirmOp: "connectionAuthorize" as const,
		streamChunks: Object.freeze([
			"Loading connection projection…",
			"Preparing authorize card…",
		]),
	});
}

export function sheetForRailLifecycle(
	snap?: YardProjectionSnapshot,
): GenerativeSheet {
	const rails = snap?.rails ?? [];
	return Object.freeze({
		kind: "rail.lifecycle" as const,
		title: "Rail Policy Board",
		description: "Publish / approve / activate Rails — `hobo station rails *`.",
		fields: Object.freeze([
			field({
				name: "hashOrId",
				label: "Rail",
				type: "select",
				required: true,
				options: rails.map((r) => r.contentHash),
				value: rails[0]?.contentHash ?? "",
			}),
			field({
				name: "action",
				label: "Action",
				type: "select",
				options: ["approve", "activate"],
				value: "activate",
			}),
		]),
		confirmOp: "stationRailsActivate" as const,
		streamChunks: Object.freeze([
			"Folding rail catalog…",
			"Streaming lifecycle sheet…",
		]),
	});
}

export function sheetForCostBooth(
	snap?: YardProjectionSnapshot,
): GenerativeSheet {
	const m = snap?.metering;
	return Object.freeze({
		kind: "cost.plan" as const,
		title: "Cost Booth",
		description: "Rail billingPolicy fare meter (projection-only).",
		fields: Object.freeze([
			field({
				name: "quotaUsed",
				label: "Quota used",
				type: "readonly",
				value: m?.quotaUsed ?? 0,
			}),
			field({
				name: "quotaLimit",
				label: "Quota limit",
				type: "readonly",
				value: m?.quotaLimit ?? 0,
			}),
			field({
				name: "spendCapUsd",
				label: "Spend cap USD",
				type: "readonly",
				value: m?.spendCapUsd ?? 0,
			}),
		]),
		confirmOp: "doctorSnapshot" as const,
		streamChunks: Object.freeze(["Reading metering projection…"]),
	});
}

export function sheetForDoctor(snap?: YardProjectionSnapshot): GenerativeSheet {
	const hazards = snap?.doctor.hazards ?? [];
	return Object.freeze({
		kind: "doctor.hazards" as const,
		title: "Error Bunker",
		description: "Doctor / drift / hazards — `hobo doctor` spirit.",
		fields: Object.freeze([
			field({
				name: "hazards",
				label: "Hazards",
				type: "readonly",
				value: hazards.join(", ") || "(none)",
			}),
			field({
				name: "hint",
				label: "Hint",
				type: "readonly",
				value: snap?.doctor.hint ?? "",
			}),
		]),
		confirmOp: "doctorSnapshot" as const,
		streamChunks: Object.freeze(["Scanning doctor projection…"]),
	});
}

export type SheetConfirmHandlers = Readonly<{
	connectionCreate: (input: {
		provider: string;
		alias?: string;
		scopes?: string[];
		stationId?: string;
	}) => ManagementResult;
	connectionAuthorize: (input: { idOrAlias: string }) => ManagementResult;
	stationRailsActivate: (input: { hashOrId: string }) => ManagementResult;
	stationRailsApprove: (input: { hashOrId: string }) => ManagementResult;
	stationRailsPublish: (input: Record<string, unknown>) => ManagementResult;
	doctorSnapshot: () => ManagementResult;
}>;

/** Confirm a sheet with field values → management op. */
export function confirmSheet(
	sheet: GenerativeSheet,
	values: Record<string, string | number>,
	handlers: SheetConfirmHandlers,
): ManagementResult {
	switch (sheet.confirmOp) {
		case "connectionCreate": {
			const input: {
				provider: string;
				alias?: string;
				scopes?: string[];
				stationId?: string;
			} = {
				provider: String(values.provider ?? ""),
			};
			if (values.alias !== undefined && String(values.alias).length > 0) {
				input.alias = String(values.alias);
			}
			if (values.scopes !== undefined && String(values.scopes).length > 0) {
				input.scopes = String(values.scopes)
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean);
			}
			if (values.stationId !== undefined) {
				input.stationId = String(values.stationId);
			}
			return handlers.connectionCreate(input);
		}
		case "connectionAuthorize":
			return handlers.connectionAuthorize({
				idOrAlias: String(values.idOrAlias ?? ""),
			});
		case "stationRailsActivate":
			return handlers.stationRailsActivate({
				hashOrId: String(values.hashOrId ?? ""),
			});
		case "stationRailsApprove":
			return handlers.stationRailsApprove({
				hashOrId: String(values.hashOrId ?? ""),
			});
		case "stationRailsPublish":
			return handlers.stationRailsPublish(values);
		case "doctorSnapshot":
			return handlers.doctorSnapshot();
		default: {
			const _exhaustive: never = sheet.confirmOp;
			return {
				ok: false,
				code: "unknown-sheet-op",
				message: String(_exhaustive),
			};
		}
	}
}
