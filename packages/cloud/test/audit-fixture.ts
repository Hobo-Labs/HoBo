import type { EventEnvelope } from "@hobo/core";
import { credentialAuditProjection } from "../src/projections/credential-audit.js";

export function fixtureRow() {
	const common = {
		v: 1,
		streamId: "audit:fixture",
		ts: "2026-11-17T12:00:00.000Z",
		actor: { kind: "user", id: "alice" },
		tenant: "tenant-a",
		correlationId: "run-1",
	} as const;
	const events: EventEnvelope[] = [
		{
			...common,
			id: "evt-1",
			seq: 1,
			type: "identity.Issued",
			data: { identityId: "identity-1" },
		},
		{
			...common,
			id: "evt-2",
			seq: 2,
			type: "token.Granted",
			data: {
				grantId: "grant-1",
				svidSubject: "spiffe://tenant-a/alice",
				scope: { port: "secret", resource: "demo", action: "read" },
			},
		},
		{
			...common,
			id: "evt-3",
			seq: 3,
			type: "mcp.ToolCallDecided",
			data: {
				tool: "capture_secret",
				subject: "alice",
				effect: "allow",
				reason: "scope granted",
			},
		},
		{
			...common,
			id: "evt-4",
			seq: 4,
			type: "secret.CaptureStored",
			data: {
				name: "DEMO_SECRET",
				ticketId: "cap_AAAAAAAAAAAAAAAAAAAAAA",
				target: "runtime",
				channel: "mcp-app",
				ref: "secref://fixture/DEMO_SECRET",
			},
		},
	];
	const row = credentialAuditProjection.query(
		credentialAuditProjection.fold(events),
	)[0];
	if (!row) throw new Error("expected an audit row");
	return row;
}
