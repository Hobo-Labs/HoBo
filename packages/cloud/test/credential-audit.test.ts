import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope, PrincipalRef } from "@hobo/core";
import {
	createManualClock,
	createRuntimeLocalEventStore,
	type RuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";

import {
	CREDENTIAL_AUDIT_RETENTION,
	CREDENTIAL_AUDIT_RETENTION_FLOOR_MS,
	collectStream,
	compactCredentialAuditStream,
	credentialAuditProjection,
} from "../src/index.js";

// S3-04 CredentialAudit projection: folds identity/token/session events into a
// grant -> use -> revoke audit correlated by correlationId; rebuildable-from-zero
// (the log is authoritative); its audit streams are never compacted (NFR-018).

const actor: PrincipalRef = { kind: "service", id: "yard/token-broker" };
const CORRELATION = "run:deploy-42:credentials";
const STREAM = "credential-audit/run-deploy-42";

let stores: RuntimeLocalEventStore[] = [];
function freshStore(): RuntimeLocalEventStore {
	const dir = mkdtempSync(join(tmpdir(), "hobo-cred-audit-"));
	const s = createRuntimeLocalEventStore({
		dataDir: dir,
		clock: createManualClock(),
	});
	stores.push(s);
	return s;
}
afterEach(() => {
	for (const s of stores) s.close();
	stores = [];
});

// A full brokered-deploy credential trail: SVID issued, token granted, used, revoked.
function credentialTrail() {
	return [
		{
			type: "identity.Issued",
			data: {
				identityId: "svid-deployer-1",
				subject: "spiffe://yard/tenant-a/agent/deployer",
				svidRef: "tokenref://identity/svid/svid-deployer-1",
			},
		},
		{
			type: "token.Granted",
			data: {
				grantId: "grant-deploy-42",
				svidSubject: "spiffe://yard/tenant-a/agent/deployer",
				tokenRef: "tokenref://broker/grant/grant-deploy-42",
				scope: { port: "database", resource: "shop.db", action: "write" },
			},
		},
		{
			type: "token.Used",
			data: {
				grantId: "grant-deploy-42",
				svidSubject: "spiffe://yard/tenant-a/agent/deployer",
			},
		},
		{
			type: "token.Revoked",
			data: { grantId: "grant-deploy-42", reason: "deploy-complete" },
		},
	];
}

async function appendTrail(store: RuntimeLocalEventStore): Promise<void> {
	await store.append(STREAM, credentialTrail(), {
		expectedSeq: 0,
		actor,
		tenant: "tenant-a",
		correlationId: CORRELATION,
	});
}

describe("CredentialAudit projection folds grant/use/revoke by correlationId", () => {
	it("reconstructs the per-grant lifecycle correlated by correlationId", async () => {
		const store = freshStore();
		await appendTrail(store);

		const snapshot = credentialAuditProjection.fold(
			await collectStream(store, STREAM),
		);
		const row = credentialAuditProjection.get(snapshot, CORRELATION);

		expect(row).toBeDefined();
		if (!row) return;
		expect(row.correlationId).toBe(CORRELATION);
		expect(row.identityIds).toEqual(["svid-deployer-1"]);
		expect(row.grantCount).toBe(1);
		expect(row.useCount).toBe(1);
		expect(row.revokeCount).toBe(1);

		const grant = row.grants["grant-deploy-42"];
		expect(grant?.status).toBe("revoked");
		expect(grant?.svidSubject).toBe("spiffe://yard/tenant-a/agent/deployer");
		expect(grant?.scope).toEqual({
			port: "database",
			resource: "shop.db",
			action: "write",
		});
		expect(grant?.useCount).toBe(1);
		expect(grant?.grantedAt).toBeDefined();
		expect(grant?.usedAt).toBeDefined();
		expect(grant?.revokedAt).toBeDefined();
		expect(grant?.revokedReason).toBe("deploy-complete");

		expect(row.timeline.map((e) => e.type)).toEqual([
			"identity.Issued",
			"token.Granted",
			"token.Used",
			"token.Revoked",
		]);
	});

	it("rebuild-from-zero equals the live fold (the log is authoritative)", async () => {
		const store = freshStore();
		await appendTrail(store);

		const live = credentialAuditProjection.fold(
			await collectStream(store, STREAM),
		);
		const rebuilt = await credentialAuditProjection.rebuildFromZero(
			store,
			STREAM,
		);

		expect(rebuilt).toEqual(live);
		expect(
			credentialAuditProjection.get(rebuilt, CORRELATION)?.grants[
				"grant-deploy-42"
			]?.status,
		).toBe("revoked");
	});
});

describe("CredentialAudit retention floor (NFR-018 — never compacted)", () => {
	function auditEnv(type: string, seq: number, ts: string): EventEnvelope {
		return {
			id: `evt-${type}-${seq}`,
			type,
			v: 1,
			streamId: "token.grants/agent-deploy",
			seq,
			ts,
			actor,
			tenant: "tenant-a",
			correlationId: CORRELATION,
			data: {
				grantId: "grant-deploy-42",
				reason: "x",
				svidSubject: "spiffe://yard/tenant-a/agent/deployer",
			},
		};
	}

	it("carries the never-compact retention descriptor", () => {
		expect(CREDENTIAL_AUDIT_RETENTION.neverCompact).toBe(true);
		expect(CREDENTIAL_AUDIT_RETENTION.class).toBe("security-audit");
	});

	it("keeps pre-floor audit events after a compaction pass and rebuilds identically", () => {
		const now = Date.parse("2026-07-01T00:00:00.000Z");
		// The grant is older than the retention floor; use/revoke are recent.
		const preFloor = new Date(
			now - CREDENTIAL_AUDIT_RETENTION_FLOOR_MS - 86_400_000,
		).toISOString();
		const events = [
			auditEnv("token.Granted", 1, preFloor),
			auditEnv("token.Used", 2, new Date(now - 60_000).toISOString()),
			auditEnv("token.Revoked", 3, new Date(now - 30_000).toISOString()),
		];

		const result = compactCredentialAuditStream(events, {
			now,
			retentionFloorMs: CREDENTIAL_AUDIT_RETENTION_FLOOR_MS,
		});

		// Never compacted: nothing dropped, including the pre-floor grant.
		expect(result.droppedCount).toBe(0);
		expect(result.auditPreserved).toBe(true);
		expect(result.retained).toHaveLength(3);
		const olderThanFloor = result.retained.filter(
			(e) => now - Date.parse(e.ts) > CREDENTIAL_AUDIT_RETENTION_FLOOR_MS,
		);
		expect(olderThanFloor).toHaveLength(1);

		// The projection built from the compacted stream equals the pre-compaction fold.
		const before = credentialAuditProjection.fold(events);
		const after = credentialAuditProjection.fold(result.retained);
		expect(after).toEqual(before);
	});

	it("never drops config.Resolved / secret.Accessed (ADR-0027)", () => {
		const now = Date.parse("2026-07-01T00:00:00.000Z");
		const preFloor = new Date(
			now - CREDENTIAL_AUDIT_RETENTION_FLOOR_MS - 86_400_000,
		).toISOString();
		const events: EventEnvelope[] = [
			{
				id: "evt-config-1",
				type: "config.Resolved",
				v: 1,
				streamId: STREAM,
				seq: 1,
				ts: preFloor,
				actor,
				tenant: "tenant-a",
				correlationId: CORRELATION,
				data: {
					name: "API_KEY",
					source: "provider-federation",
					valueRef: "secref://API_KEY/v1",
					redacted: true,
				},
			},
			{
				id: "evt-secret-1",
				type: "secret.Accessed",
				v: 1,
				streamId: STREAM,
				seq: 2,
				ts: preFloor,
				actor,
				tenant: "tenant-a",
				correlationId: CORRELATION,
				data: {
					name: "API_KEY",
					source: "provider-federation",
					valueRef: "secref://API_KEY/v1",
					versionId: "v1",
					redacted: true,
					plaintextPresent: false,
				},
			},
		];
		const result = compactCredentialAuditStream(events, {
			now,
			retentionFloorMs: CREDENTIAL_AUDIT_RETENTION_FLOOR_MS,
		});
		expect(result.droppedCount).toBe(0);
		expect(result.auditPreserved).toBe(true);
		const fold = credentialAuditProjection.fold(events);
		const row = credentialAuditProjection.get(fold, CORRELATION);
		expect(row?.configNames).toEqual(["API_KEY"]);
		expect(row?.secretValueRefs).toEqual(["secref://API_KEY/v1"]);
		expect(row?.configResolveCount).toBe(1);
		expect(row?.secretAccessCount).toBe(1);
		expect(JSON.stringify(row)).not.toMatch(/password|api[_-]?key\s*[:=]/i);
	});
});

describe("CredentialAudit folds identity migration events", () => {
	it("records migrationIds and never drops migration audit events", () => {
		const events: EventEnvelope[] = [
			{
				id: "evt-mig-1",
				type: "identity.MigrationStarted",
				v: 1,
				streamId: STREAM,
				seq: 1,
				ts: "2026-01-01T00:00:00.000Z",
				actor,
				tenant: "tenant-a",
				correlationId: CORRELATION,
				data: {
					migrationId: "mig_test1",
					sourceAdapter: "a",
					targetAdapter: "b",
					reason: "adapter-change",
					mappingSpecHash: "sha256:abc",
					mode: "jit",
				},
			},
			{
				id: "evt-mig-2",
				type: "identity.Migrated",
				v: 1,
				streamId: STREAM,
				seq: 2,
				ts: "2026-01-01T00:00:01.000Z",
				actor,
				tenant: "tenant-a",
				correlationId: CORRELATION,
				data: {
					migrationId: "mig_test1",
					principalRef: "principal:t:x",
					targetAdapter: "b",
				},
			},
		];
		const snapshot = credentialAuditProjection.fold(events);
		const row = credentialAuditProjection.get(snapshot, CORRELATION);
		expect(row?.migrationIds).toEqual(["mig_test1"]);
		expect(row?.migrationEventCount).toBe(2);
		expect(row?.timeline.map((e) => e.type)).toEqual([
			"identity.MigrationStarted",
			"identity.Migrated",
		]);
	});
});
