import { readFileSync } from "node:fs";
import {
	create,
	createFileRegistry,
	fromBinary,
	fromJson,
	type JsonValue,
	toBinary,
	toJson,
} from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import { expect, it } from "vitest";
import { CredentialAuditProjectionViewSchema } from "../src/_generated/management_pb.js";
import {
	decodeCredentialAuditView,
	encodeCredentialAuditView,
} from "../src/credential-audit-wire.js";

it("round-trips the management wire view and reads the previous schema", () => {
	const fixture: JsonValue = JSON.parse(
		readFileSync(
			new URL(
				"../data-models/fixtures/credential_audit_projection_view/valid/partial.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	const message = fromJson(CredentialAuditProjectionViewSchema, fixture);
	const decoded = decodeCredentialAuditView(
		toBinary(CredentialAuditProjectionViewSchema, message),
	);
	expect(decoded).toMatchObject({
		available: true,
		sources: ["mcp-audit"],
		count: 1,
		seq: 99,
		partial: true,
		skippedSources: ["connections-store"],
	});
	expect(decoded.rows[0]).toMatchObject({
		tenant: "tenant-a",
		correlationId: "run-1",
	});
	const encoded = encodeCredentialAuditView(decoded);
	expect(
		toJson(
			CredentialAuditProjectionViewSchema,
			fromBinary(CredentialAuditProjectionViewSchema, encoded),
		),
	).toEqual(fixture);
	const descriptor = fromBinary(
		FileDescriptorSetSchema,
		readFileSync(
			new URL("./fixtures/management-v1.descriptor.bin", import.meta.url),
		),
	);
	const legacy = createFileRegistry(descriptor).getMessage(
		"hobo.management.v1.CredentialAuditProjectionView",
	);
	if (!legacy) throw new Error("legacy management descriptor missing");
	expect(toJson(legacy, fromBinary(legacy, encoded))).toMatchObject({
		available: true,
		count: 1,
		seq: "99",
	});
	const oldMessage = fromJson(legacy, {
		available: true,
		sources: ["yard-eventstore"],
		count: 0,
		seq: "2",
		jsonRows: "[]",
	});
	expect(decodeCredentialAuditView(toBinary(legacy, oldMessage))).toMatchObject(
		{ partial: false, skippedSources: [], seq: 2 },
	);
});

it("rejects invalid rows, counts, sources and sequence values", () => {
	const wire = (
		values: Parameters<
			typeof create<typeof CredentialAuditProjectionViewSchema>
		>[1],
	) =>
		toBinary(
			CredentialAuditProjectionViewSchema,
			create(CredentialAuditProjectionViewSchema, values),
		);
	expect(() => decodeCredentialAuditView(wire({ jsonRows: "{" }))).toThrow(
		"invalid rows JSON",
	);
	expect(() => decodeCredentialAuditView(wire({ jsonRows: "{}" }))).toThrow(
		"rows must be an array",
	);
	expect(() =>
		decodeCredentialAuditView(wire({ jsonRows: "[]", count: 1 })),
	).toThrow("row count does not match");
	expect(() =>
		decodeCredentialAuditView(
			wire({ seq: BigInt(Number.MAX_SAFE_INTEGER) + 1n }),
		),
	).toThrow("invalid sequence");
	expect(() =>
		decodeCredentialAuditView(wire({ sources: ["invented"], available: true })),
	).toThrow("invalid source");
	expect(() => decodeCredentialAuditView(wire({ partial: true }))).toThrow(
		"partial status does not match",
	);
});
