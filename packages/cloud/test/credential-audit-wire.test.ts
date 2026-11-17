import { readFileSync } from "node:fs";
import {
	create,
	createFileRegistry,
	fromBinary,
	fromJson,
	toBinary,
	toJson,
} from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import { expect, it } from "vitest";
import { CredentialAuditRecordSchema } from "../src/_generated/cloud_pb.js";
import {
	credentialAuditRowFromJson,
	credentialAuditRowToJson,
	decodeCredentialAuditRow,
	encodeCredentialAuditRow,
} from "../src/projections/credential-audit-wire.js";
import { fixtureRow } from "./audit-fixture.js";

it("round-trips a projected audit and remains readable by the previous wire schema", () => {
	const row = fixtureRow();
	const encoded = encodeCredentialAuditRow(row);
	expect(decodeCredentialAuditRow(encoded)).toEqual(row);
	const message = fromBinary(CredentialAuditRecordSchema, encoded);
	const json = toJson(CredentialAuditRecordSchema, message);
	expect(credentialAuditRowFromJson(credentialAuditRowToJson(row))).toEqual(
		row,
	);
	expect(`${JSON.stringify(json, null, 2)}\n`).toBe(
		readFileSync(
			new URL(
				"../data-models/fixtures/credential_audit_record/valid/control-audit.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	const descriptor = fromBinary(
		FileDescriptorSetSchema,
		readFileSync(
			new URL("./fixtures/credential-audit-v1.descriptor.bin", import.meta.url),
		),
	);
	const legacy = createFileRegistry(descriptor).getMessage(
		"hobo.cloud.v1.CredentialAuditRecord",
	);
	if (!legacy) throw new Error("legacy credential audit descriptor missing");
	expect(toJson(legacy, fromBinary(legacy, encoded))).toMatchObject({
		correlationId: "run-1",
		grantCount: 1,
		grants: [expect.objectContaining({ grantId: "grant-1" })],
	});
	const oldMessage = fromJson(legacy, {
		correlationId: "legacy-run",
		grants: [{ grantId: "legacy-grant", status: "used", useCount: 1 }],
		grantCount: 1,
		useCount: 1,
	});
	const restoredLegacy = decodeCredentialAuditRow(toBinary(legacy, oldMessage));
	expect(restoredLegacy).toMatchObject({
		correlationId: "legacy-run",
		grants: { "legacy-grant": { status: "used", useCount: 1 } },
		connectionIds: [],
	});
	expect(restoredLegacy.tenant).toBeUndefined();
});

it("rejects invalid or ambiguous audit wire records", () => {
	const row = fixtureRow();
	expect(() =>
		encodeCredentialAuditRow({
			...row,
			timeline: [{ seq: 0x1_0000_0000, type: "token.Used" }],
		}),
	).toThrow("unsigned 32-bit");
	expect(() =>
		encodeCredentialAuditRow({
			...row,
			grants: { wrong: row.grants["grant-1"] },
		}),
	).toThrow("grant id does not match");
	const grant = { grantId: "same", status: "used", useCount: 1 };
	const duplicate = create(CredentialAuditRecordSchema, {
		correlationId: "run",
		grants: [grant, grant],
	});
	expect(() =>
		decodeCredentialAuditRow(toBinary(CredentialAuditRecordSchema, duplicate)),
	).toThrow("duplicate grant id");
	const badEffect = create(CredentialAuditRecordSchema, {
		correlationId: "run",
		timeline: [{ seq: 1, type: "mcp.ToolCallDecided", effect: "permit" }],
	});
	expect(() =>
		decodeCredentialAuditRow(toBinary(CredentialAuditRecordSchema, badEffect)),
	).toThrow("invalid effect");
});
