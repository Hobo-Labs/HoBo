import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CliContext } from "@hobo/cli";
import type { CredentialAuditRow } from "@hobo/cloud";
import type { EventEnvelope } from "@hobo/core";
import { first, must, mustGet } from "@hobo/core/total-access";
import { createInMemoryKms, JwtSvidIssuer } from "@hobo/identity";
import type { RuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";
import {
	auditEventsToOcsf,
	createAttestCommand,
	createComposedHoboCli,
	createDefaultYardRuntime,
	credentialAuditToOcsf,
	verifyOcsfBatchSignature,
} from "../src/index.js";
import type { JsonObject } from "../src/json.js";

// `hobo attest` folds the CredentialAudit projection (emitted on the deploy path)
// and exports it as OCSF 1.x Authorization evidence. The happy path deploys for
// real, then attests the SAME runtime and asserts the OCSF taxonomy + credential
// chain + integrity seal. Also covers the no-facts and no-runtime cases.

const HELLO_BINDLE = {
	schema: "hobo.manifest/v1",
	componentHost: { kind: "wasmtime", version: "1.0.0" },
	resources: {
		service: {
			type: "component.v1",
			image: "oci://registry.example.com/hello-bindle@sha256:abc123",
			runtime: "wasm",
			exports: ["wasi:http/incoming-handler"],
			bind: ["sessions"],
		},
		sessions: { type: "data.v1", port: "kv" },
	},
};

let openStores: RuntimeLocalEventStore[] = [];
afterEach(() => {
	for (const store of openStores) store.close();
	openStores = [];
});

async function withProject(
	callback: (cwd: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(path.join(tmpdir(), "hobo-attest-"));
	await writeFile(
		path.join(dir, "hobo.bindle.json"),
		`${JSON.stringify(HELLO_BINDLE, null, 2)}\n`,
	);
	try {
		await callback(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function runInput(cwd: string) {
	return {
		// SAFETY: assertion required at this I/O or test boundary.
		context: { cwd, projectDir: cwd } as CliContext,
		// SAFETY: assertion required at this I/O or test boundary.
		flags: { cwd } as never,
		// SAFETY: assertion required at this I/O or test boundary.
		args: [] as readonly string[],
		verb: "attest",
		emitProgress: () => {},
	};
}

// biome-ignore lint/suspicious/noExplicitAny: test-only envelope reader.
function envelope(stdout: string): any {
	return JSON.parse(stdout);
}

describe("createAttestCommand", () => {
	it("exports OCSF Authorization evidence from the deploy credential-audit trail", async () => {
		await withProject(async (cwd) => {
			const runtime = createDefaultYardRuntime();
			// SAFETY: assertion required at this I/O or test boundary.
			openStores.push(runtime.store as RuntimeLocalEventStore);
			const cli = createComposedHoboCli({ yardRuntime: runtime });

			const up = envelope((await cli.run(["up", "--json"], { cwd })).stdout);
			expect(up.status).toBe("deployed");

			const attest = envelope(
				(await cli.run(["attest", "--json"], { cwd })).stdout,
			);
			expect(attest.code).not.toBe("HOBO_CLI_STUB");
			expect(attest.ok).toBe(true);
			expect(attest.status).toBe("attested");
			expect(attest.data.format).toBe("ocsf-1.x");
			// One grant per provisioned resource (service + sessions).
			expect(attest.data.records).toBe(2);

			const batch = attest.data.batches[0];
			expect(batch.export_version).toBe("hobo.identity-ocsf-export/v1");
			expect(batch.sealDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
			expect(batch.ordering.mode).toBe("ordered");

			const record = batch.records[0];
			// Faithful OCSF taxonomy: IAM category 3, Authorization class 3004.
			expect(record.category_uid).toBe(3);
			expect(record.class_uid).toBe(3004);
			expect(record.class_name).toBe("Authorization");
			// Terminal lifecycle state is revoked -> activity 4, type_uid 300404.
			expect(record.activity_id).toBe(4);
			expect(record.type_uid).toBe(300404);
			// The linked credential chain carries the grant lifecycle + scope.
			const chain = record.hobo.credential_chain;
			expect(chain.grantId).toBeTruthy();
			expect(chain.scope.action).toBe("apply");
			expect(chain.grantedAt).toBeTruthy();
			expect(chain.usedAt).toBeTruthy();
			expect(chain.revokedAt).toBeTruthy();
		});
	});

	it("is deterministic: the seal digest is stable across two exports of the same log", async () => {
		await withProject(async (cwd) => {
			const runtime = createDefaultYardRuntime();
			// SAFETY: assertion required at this I/O or test boundary.
			openStores.push(runtime.store as RuntimeLocalEventStore);
			const cli = createComposedHoboCli({ yardRuntime: runtime });
			await cli.run(["up", "--json"], { cwd });

			const a = envelope((await cli.run(["attest", "--json"], { cwd })).stdout);
			const b = envelope((await cli.run(["attest", "--json"], { cwd })).stdout);
			expect(a.data.batches[0].sealDigest).toBe(b.data.batches[0].sealDigest);
		});
	});

	it("reports no audit facts for a project that has never deployed", async () => {
		await withProject(async (cwd) => {
			const runtime = createDefaultYardRuntime();
			// SAFETY: assertion required at this I/O or test boundary.
			openStores.push(runtime.store as RuntimeLocalEventStore);
			const cli = createComposedHoboCli({ yardRuntime: runtime });

			const attest = envelope(
				(await cli.run(["attest", "--json"], { cwd })).stdout,
			);
			expect(attest.ok).toBe(true);
			expect(attest.status).toBe("no_audit_facts");
			expect(attest.data.records).toBe(0);
		});
	});

	it("reports unavailable when no runtime is wired", async () => {
		const result = await createAttestCommand().run(runInput("/tmp"));
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_NO_RUNTIME");
	});
});

// --- ADR-0046 §2 widening: Authentication + configuration-change classes over
// the wider audit families, batch signing, and the one-way PII boundary. ---

function auditEvent(
	type: string,
	seq: number,
	data: JsonObject,
	overrides: Partial<EventEnvelope> = {},
): EventEnvelope {
	return {
		id: `evt-${seq}`,
		type,
		v: 1,
		streamId: "deployment:d1",
		seq,
		ts: `2026-08-04T00:0${seq % 10}:00.000Z`,
		actor: { kind: "user", id: "user:alice" },
		tenant: "t1",
		correlationId: "corr-audit-1",
		data,
		...overrides,
	};
}

const ADR_0046_EVENTS: readonly EventEnvelope[] = [
	auditEvent("policy.Decided", 1, {
		effect: "allow",
		action: "deploy.apply",
		subject: "user:alice",
	}),
	auditEvent("data.Classified", 2, {
		resource: "sessions",
		labels: ["pii"],
		classifiedBy: "user:alice",
	}),
	auditEvent("erasure.Requested", 3, { subject: "user:alice" }),
	auditEvent("erasure.Completed", 4, { subject: "user:alice" }),
	auditEvent("flag.Changed", 5, { flagKey: "checkout-v2", env: "prod" }),
	auditEvent("registry.BundleImported", 6, {
		bundleId: "bundle:hello",
		digest: "sha256:abc",
	}),
];

function testIssuer(): JwtSvidIssuer {
	const kms = createInMemoryKms();
	kms.generateRsaKey("ocsf-seal-k1");
	return new JwtSvidIssuer({
		issuerUrl: "https://issuer.test",
		kms,
		activeKeyId: "ocsf-seal-k1",
		jwksKeyIds: ["ocsf-seal-k1"],
	});
}

describe("auditEventsToOcsf (ADR-0046 §2 widening)", () => {
	it("maps policy.Decided to an OCSF Authentication record with decision status", () => {
		const batch = auditEventsToOcsf(ADR_0046_EVENTS);
		const record = first(batch.records);
		expect(record.category_uid).toBe(3);
		expect(record.category_name).toBe("Identity & Access Management");
		expect(record.class_uid).toBe(3002);
		expect(record.class_name).toBe("Authentication");
		expect(record.activity_id).toBe(1);
		expect(record.type_uid).toBe(300201);
		expect(record.severity_id).toBe(1);
		expect(record.status).toBe("Success");

		const denied = auditEventsToOcsf([
			auditEvent("policy.Decided", 1, { effect: "deny", action: "x" }),
		]);
		expect(first(denied.records).status).toBe("Failure");
	});

	it("maps the configuration-change families onto the config-change class", () => {
		const batch = auditEventsToOcsf(ADR_0046_EVENTS);
		const byType = new Map(
			batch.records.map((record) => [
				// SAFETY: assertion required at this I/O or test boundary.
				(record as { hobo: { source_event: { type: string } } }).hobo
					.source_event.type,
				record,
			]),
		);
		for (const [type, activityId, activityName] of [
			["flag.Changed", 1, "Flag Changed"],
			["registry.BundleImported", 2, "Bundle Imported"],
			["data.Classified", 3, "Data Classified"],
			["erasure.Requested", 4, "Erasure Requested"],
			["erasure.Completed", 5, "Erasure Completed"],
		] as const) {
			const record = mustGet(byType, type);
			expect(record.category_uid).toBe(5);
			expect(record.class_uid).toBe(5019);
			expect(record.class_name).toBe("Device Config State Change");
			expect(record.activity_id).toBe(activityId);
			expect(record.activity_name).toBe(activityName);
			expect(record.type_uid).toBe(5019 * 100 + activityId);
		}
		// The erasure.* family is open-ended: unknown facts still export.
		const progressed = auditEventsToOcsf([
			auditEvent("erasure.KeyDestroyed", 1, { subject: "user:alice" }),
		]);
		expect(first(progressed.records).activity_id).toBe(6);
		expect(first(progressed.records).activity_name).toBe("Erasure Progressed");
	});

	it("carries per-line traceability to the source event and skips unmapped families", () => {
		const batch = auditEventsToOcsf([
			...ADR_0046_EVENTS,
			auditEvent("token.Granted", 7, { grantId: "g1" }),
		]);
		// token.* stays on the credential-audit exporter, not this surface.
		expect(batch.records).toHaveLength(ADR_0046_EVENTS.length);
		// SAFETY: assertion required at this I/O or test boundary.
		const record = batch.records[1] as {
			hobo: {
				export_kind: string;
				correlation_id: string;
				source_event: JsonObject;
			};
		};
		expect(record.hobo.export_kind).toBe("audit-event");
		expect(record.hobo.correlation_id).toBe("corr-audit-1");
		expect(record.hobo.source_event).toMatchObject({
			id: "evt-2",
			type: "data.Classified",
			seq: 2,
			stream_id: "deployment:d1",
			tenant: "t1",
		});
		expect(batch.correlationId).toBe("corr-audit-1");
		expect(batch.ordering.mode).toBe("ordered");
	});

	it("labels a non-monotonic audit timeline as unordered", () => {
		const batch = auditEventsToOcsf([
			auditEvent("flag.Changed", 5, { flagKey: "a" }),
			auditEvent("flag.Changed", 2, { flagKey: "b" }),
		]);
		expect(batch.ordering).toEqual({
			mode: "unordered",
			reason: "non-monotonic-seq",
		});
	});

	it("stays digest-only without a signer and signs verifiably with one", () => {
		const unsigned = auditEventsToOcsf(ADR_0046_EVENTS);
		expect(unsigned.sealDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(unsigned.sealSignature).toBeUndefined();

		const issuer = testIssuer();
		const signed = auditEventsToOcsf(ADR_0046_EVENTS, { signer: issuer });
		// Signing never changes the digest — the seal is content-addressed.
		expect(signed.sealDigest).toBe(unsigned.sealDigest);
		expect(signed.sealSignature).toMatchObject({
			kid: "ocsf-seal-k1",
			alg: "RS256",
		});
		expect(must(signed.sealSignature).jws.split(".")).toHaveLength(3);
		expect(verifyOcsfBatchSignature(signed, issuer.jwks())).toEqual({
			valid: true,
		});
	});

	it("rejects a tampered batch, a foreign key, and an unsigned batch", () => {
		const issuer = testIssuer();
		const signed = auditEventsToOcsf(ADR_0046_EVENTS, { signer: issuer });

		const tampered = {
			...signed,
			records: signed.records.map((record, i) =>
				i === 0 ? { ...record, message: "forged" } : record,
			),
		};
		expect(verifyOcsfBatchSignature(tampered, issuer.jwks()).valid).toBe(false);

		const stranger = testIssuer();
		expect(verifyOcsfBatchSignature(signed, stranger.jwks()).valid).toBe(false);

		const unsigned = auditEventsToOcsf(ADR_0046_EVENTS);
		expect(verifyOcsfBatchSignature(unsigned, issuer.jwks())).toEqual({
			valid: false,
			reason: "unsigned",
		});
	});

	it("signs the credential-audit batch through the same seam", () => {
		const row: CredentialAuditRow = {
			correlationId: "corr-cred-1",
			grants: {
				g1: {
					grantId: "g1",
					svidSubject: "spiffe://t1/svc",
					status: "revoked",
					grantedAt: "2026-08-04T00:00:00.000Z",
					usedAt: "2026-08-04T00:01:00.000Z",
					revokedAt: "2026-08-04T00:02:00.000Z",
					useCount: 1,
				},
			},
			identityIds: [],
			sessionIds: [],
			connectionIds: [],
			configNames: [],
			secretValueRefs: [],
			migrationIds: [],
			timeline: [
				{ seq: 1, type: "token.Granted", grantId: "g1" },
				{ seq: 2, type: "token.Used", grantId: "g1" },
				{ seq: 3, type: "token.Revoked", grantId: "g1" },
			],
			grantCount: 1,
			useCount: 1,
			revokeCount: 1,
			configResolveCount: 0,
			secretAccessCount: 0,
			migrationEventCount: 0,
		};
		const issuer = testIssuer();
		const signed = credentialAuditToOcsf(row, { signer: issuer });
		expect(verifyOcsfBatchSignature(signed, issuer.jwks())).toEqual({
			valid: true,
		});
		// No signer -> the pre-existing digest-only shape, byte for byte.
		const unsigned = credentialAuditToOcsf(row);
		expect(unsigned.sealSignature).toBeUndefined();
		expect(unsigned.sealDigest).toBe(signed.sealDigest);
	});

	it("redacts crypto-shredded subjects everywhere in the new classes", () => {
		const erasedSubjects = new Set(["user:alice"]);
		const batch = auditEventsToOcsf(ADR_0046_EVENTS, { erasedSubjects });
		const serialized = JSON.stringify(batch);
		// The one-way PII boundary: no raw erased identifier crosses the export,
		// not in actor refs, decision subjects, nested labels, or erasure facts.
		expect(serialized).not.toContain("user:alice");
		expect(serialized).toContain("[erased:");
		// Redaction is stable so evidence stays linkable across records.
		const refs = new Set(serialized.match(/\[erased:[0-9a-f]{16}\]/g));
		expect(refs.size).toBe(1);
		// Non-PII payload survives untouched.
		expect(serialized).toContain("checkout-v2");
		expect(serialized).toContain("bundle:hello");
	});
});
