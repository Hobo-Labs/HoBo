import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
} from "node:fs";
import { join } from "node:path";
import type { PrincipalRef } from "@hobo/core";
import type {
	AuthDecisionEvent,
	McpPrincipal,
	RateLimitEvent,
} from "@hobo/mcp";
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";

export function openMcpAuditJournal(hoboHome: string) {
	const dataDir = join(hoboHome, "mcp-audit");
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	const directory = lstatSync(dataDir);
	if (
		!directory.isDirectory() ||
		(directory.mode & 0o077) !== 0 ||
		!ownedByCurrentUser(directory.uid)
	) {
		throw new Error(
			"MCP audit directory must be private and owned by the current user",
		);
	}
	const dbPath = join(dataDir, "eventstore.sqlite");
	const descriptor = openSync(
		dbPath,
		constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		const file = fstatSync(descriptor);
		if (
			!file.isFile() ||
			file.nlink !== 1 ||
			(file.mode & 0o077) !== 0 ||
			!ownedByCurrentUser(file.uid)
		) {
			throw new Error(
				"MCP audit database must be private and owned by the current user",
			);
		}
	} finally {
		closeSync(descriptor);
	}
	const store = createRuntimeLocalEventStore({
		dataDir,
		dbPath,
		clock: { now: () => new Date().toISOString() },
	});
	return {
		async record(event: AuthDecisionEvent | RateLimitEvent): Promise<void> {
			await store.append(
				`mcp-audit:${event.id}`,
				[
					{
						type: event.type,
						data: event.data,
						meta: {
							sourceEventId: event.id,
							sourceSequence: event.seq,
							sourceTime: event.time,
							schemaVersion: event.schemaVersion,
							retention: event.retention,
						},
					},
				],
				{
					expectedSeq: 0,
					actor: auditPrincipal(event.actor),
					tenant: event.tenant,
					correlationId: event.correlationId,
				},
			);
		},
		close(): void {
			store.close();
		},
	};
}

function ownedByCurrentUser(uid: number): boolean {
	return process.getuid === undefined || process.getuid() === uid;
}

function auditPrincipal(principal: McpPrincipal): PrincipalRef {
	if (
		(principal.kind === "user" ||
			principal.kind === "agent" ||
			principal.kind === "service" ||
			principal.kind === "system") &&
		principal.id.length > 0
	) {
		return { kind: principal.kind, id: principal.id };
	}
	throw new Error("MCP audit principal is invalid");
}
