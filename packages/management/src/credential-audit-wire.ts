import {
	create,
	fromBinary,
	type JsonValue,
	toBinary,
} from "@bufbuild/protobuf";
import {
	credentialAuditRowFromJson,
	credentialAuditRowToJson,
} from "@hobo/cloud";
import { CredentialAuditProjectionViewSchema } from "./_generated/management_pb.js";
import type {
	CredentialAuditProjectionView,
	CredentialAuditSource,
} from "./cloud-projections.js";

function source(value: string): CredentialAuditSource {
	if (
		value === "connections-store" ||
		value === "yard-eventstore" ||
		value === "mcp-audit"
	)
		return value;
	throw new TypeError("credential audit: invalid source");
}

function validateView(view: CredentialAuditProjectionView): void {
	if (!Number.isSafeInteger(view.seq) || view.seq < 0)
		throw new TypeError("credential audit: invalid sequence");
	if (
		!Number.isSafeInteger(view.count) ||
		view.count < 0 ||
		view.count > 0xffff_ffff ||
		view.count !== view.rows.length
	)
		throw new TypeError("credential audit: row count does not match");
	if (view.available !== view.sources.length > 0)
		throw new TypeError(
			"credential audit: availability does not match sources",
		);
	if (new Set(view.sources).size !== view.sources.length)
		throw new TypeError("credential audit: duplicate source");
	for (const item of view.sources) source(item);
	if (
		view.partial !== view.skippedSources.length > 0 ||
		view.skippedSources.some((item) => item.length === 0)
	)
		throw new TypeError(
			"credential audit: partial status does not match skipped sources",
		);
}

export function encodeCredentialAuditView(
	view: CredentialAuditProjectionView,
): Uint8Array {
	validateView(view);
	return toBinary(
		CredentialAuditProjectionViewSchema,
		create(CredentialAuditProjectionViewSchema, {
			available: view.available,
			sources: [...view.sources],
			count: view.count,
			seq: BigInt(view.seq),
			jsonRows: JSON.stringify(view.rows.map(credentialAuditRowToJson)),
			partial: view.partial,
			skippedSources: [...view.skippedSources],
		}),
	);
}

export function decodeCredentialAuditView(
	bytes: Uint8Array,
): CredentialAuditProjectionView {
	const wire = fromBinary(CredentialAuditProjectionViewSchema, bytes);
	if (wire.seq > BigInt(Number.MAX_SAFE_INTEGER))
		throw new TypeError("credential audit: invalid sequence");
	let values: JsonValue;
	try {
		values = JSON.parse(wire.jsonRows || "[]");
	} catch {
		throw new TypeError("credential audit: invalid rows JSON");
	}
	if (!Array.isArray(values))
		throw new TypeError("credential audit: rows must be an array");
	const view: CredentialAuditProjectionView = {
		available: wire.available,
		sources: wire.sources.map(source),
		count: wire.count,
		seq: Number(wire.seq),
		rows: values.map(credentialAuditRowFromJson),
		partial: wire.partial,
		skippedSources: [...wire.skippedSources],
	};
	validateView(view);
	return view;
}
