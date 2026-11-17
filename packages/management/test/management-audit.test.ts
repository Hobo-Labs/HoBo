import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";
import { expect, it } from "vitest";
import { projectCredentialAudit } from "../src/cloud-projections.js";
import { createManagementContext } from "../src/context.js";
import {
	decodeCredentialAuditView,
	encodeCredentialAuditView,
} from "../src/credential-audit-wire.js";

it("reads durable MCP and capture audit records with tenant isolation", async () => {
	const home = mkdtempSync(join(tmpdir(), "hobo-management-audit-"));
	const store = createRuntimeLocalEventStore({
		dataDir: join(home, "mcp-audit"),
	});
	let open = true;
	try {
		await store.append(
			"mcp-audit:a",
			[
				{
					type: "mcp.ToolCallDecided",
					data: {
						tool: "capture_secret",
						subject: "alice",
						effect: "allow",
						reason: "scope",
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
		await store.append(
			"mcp-audit:b",
			[
				{
					type: "mcp.ToolCallDecided",
					data: {
						tool: "capture_secret",
						subject: "bob",
						effect: "deny",
						reason: "scope",
					},
				},
			],
			{
				expectedSeq: 0,
				tenant: "tenant-b",
				actor: { kind: "user", id: "bob" },
				correlationId: "shared",
			},
		);
		await store.append(
			"mcp-capture-audit:c",
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
				correlationId: "capture-1",
			},
		);
		store.close();
		open = false;
		const ctx = createManagementContext({ hoboHome: home });
		const all = await projectCredentialAudit(ctx);
		if (!all.data) throw new Error("expected audit view");
		expect(
			decodeCredentialAuditView(encodeCredentialAuditView(all.data)),
		).toEqual(all.data);
		expect(all.data).toMatchObject({
			available: true,
			partial: false,
			sources: ["mcp-audit"],
			skippedSources: [],
		});
		expect(
			all.data?.rows.filter((row) => row.correlationId === "shared"),
		).toHaveLength(2);
		expect(
			all.data?.rows.find(
				(row) => row.tenant === "tenant-a" && row.correlationId === "shared",
			)?.timeline[0],
		).toMatchObject({
			tool: "capture_secret",
			subject: "alice",
			effect: "allow",
		});
		expect(
			all.data?.rows.find((row) => row.tenant === "tenant-b")?.timeline[0],
		).toMatchObject({ subject: "bob", effect: "deny" });
		expect(
			all.data?.rows.find((row) => row.correlationId === "capture-1")
				?.timeline[0],
		).toMatchObject({
			name: "DEMO_SECRET",
			ref: "secref://fixture/DEMO_SECRET",
		});
		const filtered = await projectCredentialAudit(ctx, { tenant: "tenant-b" });
		expect(filtered.data?.rows).toHaveLength(1);
		expect(filtered.data?.rows[0]?.tenant).toBe("tenant-b");
	} finally {
		if (open) store.close();
		rmSync(home, { recursive: true, force: true });
	}
});

it("reports malformed and unreadable sources while keeping valid records", async () => {
	const home = mkdtempSync(join(tmpdir(), "hobo-management-partial-"));
	try {
		mkdirSync(join(home, "connections"), { recursive: true });
		const valid = {
			id: "event-1",
			type: "connection.Created",
			seq: 1,
			time: "2026-11-17T12:00:00.000Z",
			actor: { kind: "user", id: "alice" },
			tenant: "tenant-a",
			correlationId: "conn-1",
			causationId: "cmd-1",
			data: { connectionId: "connection-1" },
		};
		writeFileSync(
			join(home, "connections", "events.jsonl"),
			`${JSON.stringify(valid)}\n{bad json\n`,
		);
		mkdirSync(join(home, "mcp-audit", "eventstore.sqlite"), {
			recursive: true,
		});
		const result = await projectCredentialAudit(
			createManagementContext({ hoboHome: home }),
		);
		expect(result.data).toMatchObject({
			available: true,
			partial: true,
			sources: ["connections-store"],
			skippedSources: ["connections-store", "mcp-audit"],
		});
		expect(result.data?.rows[0]?.connectionIds).toEqual(["connection-1"]);
		expect(result.message).toContain("partial");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

it("refuses yard paths outside the yard directory", async () => {
	const home = mkdtempSync(join(tmpdir(), "hobo-management-yard-"));
	try {
		await expect(
			projectCredentialAudit(createManagementContext({ hoboHome: home }), {
				yard: "../outside",
			}),
		).rejects.toThrow("yard must be a directory name");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

it("distinguishes an unreadable audit source from an absent one", async () => {
	const home = mkdtempSync(join(tmpdir(), "hobo-management-unreadable-"));
	try {
		mkdirSync(join(home, "mcp-audit", "eventstore.sqlite"), {
			recursive: true,
		});
		const result = await projectCredentialAudit(
			createManagementContext({ hoboHome: home }),
		);
		expect(result.data).toMatchObject({
			available: false,
			partial: true,
			sources: [],
			skippedSources: ["mcp-audit"],
			rows: [],
		});
		expect(result.message).toContain("could not be read");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
