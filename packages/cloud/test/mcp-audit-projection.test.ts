import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@hobo/core";
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";
import { expect, it } from "vitest";
import {
	compactCredentialAuditStream,
	credentialAuditProjection,
	getCredentialAuditRow,
} from "../src/projections/credential-audit.js";

it("retains and folds MCP decisions separately for tenants with the same correlation", async () => {
	const home = mkdtempSync(join(tmpdir(), "hobo-audit-projection-"));
	const first = createRuntimeLocalEventStore({ dataDir: join(home, "a") });
	const second = createRuntimeLocalEventStore({ dataDir: join(home, "b") });
	try {
		await first.append(
			"mcp-audit:a",
			[
				{
					type: "mcp.ToolCallDecided",
					data: {
						tool: "capture_secret",
						subject: "alice",
						effect: "allow",
						reason: "granted",
					},
				},
			],
			{
				expectedSeq: 0,
				tenant: "tenant-a",
				actor: { kind: "user", id: "alice" },
				correlationId: "shared",
			},
		);
		await first.append(
			"mcp-audit:capture",
			[
				{
					type: "secret.CaptureStored",
					data: { name: "DEMO_SECRET", ref: "secref://fixture/DEMO_SECRET" },
				},
			],
			{
				expectedSeq: 0,
				tenant: "tenant-a",
				actor: { kind: "user", id: "alice" },
				correlationId: "shared",
			},
		);
		await second.append(
			"mcp-audit:b",
			[
				{
					type: "mcp.ToolCallDecided",
					data: { tool: "up", subject: "bob", effect: "deny", reason: "scope" },
				},
			],
			{
				expectedSeq: 0,
				tenant: "tenant-b",
				actor: { kind: "agent", id: "bob" },
				correlationId: "shared",
			},
		);
		const events: EventEnvelope[] = [];
		for await (const item of first.readAll()) events.push(item.event);
		for await (const item of second.readAll()) events.push(item.event);
		const compacted = compactCredentialAuditStream(events, {
			now: Date.parse("2040-01-01T00:00:00Z"),
		});
		expect(compacted.retained).toHaveLength(3);
		expect(compacted.auditPreserved).toBe(true);
		const snapshot = credentialAuditProjection.fold(compacted.retained);
		const rows = credentialAuditProjection.query(snapshot);
		expect(rows).toHaveLength(2);
		expect(credentialAuditProjection.get(snapshot, "shared")).toBeUndefined();
		const alice = rows.find((row) => row.tenant === "tenant-a");
		const bob = rows.find((row) => row.tenant === "tenant-b");
		expect(getCredentialAuditRow(snapshot, "tenant-a", "shared")).toEqual(
			alice,
		);
		expect(getCredentialAuditRow(snapshot, "tenant-b", "shared")).toEqual(bob);
		expect(
			getCredentialAuditRow(snapshot, "tenant-c", "shared"),
		).toBeUndefined();
		expect(alice?.timeline).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "mcp.ToolCallDecided",
					tool: "capture_secret",
					subject: "alice",
					effect: "allow",
					actorKind: "user",
					actorId: "alice",
				}),
				expect.objectContaining({
					type: "secret.CaptureStored",
					name: "DEMO_SECRET",
					ref: "secref://fixture/DEMO_SECRET",
				}),
			]),
		);
		expect(bob?.timeline).toEqual([
			expect.objectContaining({
				type: "mcp.ToolCallDecided",
				tool: "up",
				subject: "bob",
				effect: "deny",
				actorKind: "agent",
				actorId: "bob",
			}),
		]);
	} finally {
		first.close();
		second.close();
		rmSync(home, { recursive: true, force: true });
	}
});

it("rejects control events that claim to carry secret material", () => {
	const event: EventEnvelope = {
		id: "evt-1",
		type: "secret.CaptureStored",
		v: 1,
		streamId: "capture",
		seq: 1,
		ts: "2026-11-17T00:00:00.000Z",
		actor: { kind: "user", id: "alice" },
		tenant: "tenant-a",
		data: { name: "DEMO_SECRET", value: "synthetic-not-allowed" },
	};
	expect(() => credentialAuditProjection.fold([event])).toThrow(
		"contains secret material",
	);
});

it.each([
	"__proto__",
	"constructor",
	"toString",
])("keeps grant %s as an own entry", (grantId) => {
	const event: EventEnvelope = {
		id: "evt-1",
		type: "token.Granted",
		v: 1,
		streamId: "grant",
		seq: 1,
		ts: "2026-11-17T00:00:00.000Z",
		actor: { kind: "user", id: "alice" },
		tenant: "tenant-a",
		data: { grantId },
	};
	const row = credentialAuditProjection.query(
		credentialAuditProjection.fold([event]),
	)[0];
	expect(row && Object.hasOwn(row.grants, grantId)).toBe(true);
	expect(row?.grants[grantId]).toMatchObject({ grantId, status: "granted" });
});
