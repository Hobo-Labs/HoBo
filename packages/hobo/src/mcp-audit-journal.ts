import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
} from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { PrincipalRef } from "@hobo/core";
import { CREDENTIAL_AUDIT_RETENTION } from "@hobo/identity";
import type {
	AuthContext,
	AuthDecisionEvent,
	McpPrincipal,
	RateLimitEvent,
	SecretCaptureEvent,
} from "@hobo/mcp";
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";

type CaptureAuditData = {
	-readonly [Key in keyof SecretCaptureEvent]: SecretCaptureEvent[Key];
};

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
		async recordCapture(
			event: SecretCaptureEvent,
			auth: AuthContext,
		): Promise<void> {
			if (!/^sec_[a-f0-9]{32}$/u.test(event.id))
				throw new Error("invalid capture audit event id");
			const actor = auditPrincipal(auth.principal);
			const data: CaptureAuditData = {
				id: event.id,
				schemaVersion: event.schemaVersion,
				type: event.type,
				seq: event.seq,
				time: event.time,
			};
			if (event.ticketId !== undefined) data.ticketId = event.ticketId;
			if (event.name !== undefined) data.name = event.name;
			if (event.target !== undefined) data.target = event.target;
			if (event.channel !== undefined) data.channel = event.channel;
			if (event.ref !== undefined) data.ref = event.ref;
			if (event.code !== undefined) data.code = event.code;
			const correlationId = `mcp-capture:${event.ticketId ?? event.id}`;
			const result = await store.append(
				`mcp-capture-audit:${event.id}`,
				[
					{
						type: event.type,
						data,
						meta: {
							idempotencyKey: event.id,
							sourceEventId: event.id,
							sourceTime: event.time,
							retention: CREDENTIAL_AUDIT_RETENTION,
						},
					},
				],
				{ expectedSeq: 0, actor, tenant: auth.tenant, correlationId },
			);
			const recorded = result.appended[0] ?? result.deduped[0];
			if (
				!recorded ||
				recorded.type !== event.type ||
				recorded.tenant !== auth.tenant ||
				!isDeepStrictEqual(recorded.actor, actor) ||
				!isDeepStrictEqual(recorded.data, data)
			)
				throw new Error("capture audit event id was reused");
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
