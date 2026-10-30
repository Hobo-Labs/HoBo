import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { create, toJson } from "@bufbuild/protobuf";
import {
	type HostingOperationRequest,
	HostingTransitionAction,
	HostingTransitionPlanSchema,
} from "@hobo/cloud";
import { canonicalJson, createBoundedFetchTransport } from "@hobo/core";
import {
	createManualClock,
	createRuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";
import {
	HostingFinancialEvidenceAttestationSchema,
	type HostingFinancialEvidenceClaims,
	HostingFinancialEvidenceClaimsSchema,
	HostingFinancialResourceBindingSchema,
} from "../src/_generated/hosting_financial_evidence_pb.js";
import {
	createHostingFinancialEvidenceReader,
	type HostingFinancialResourceScope,
	hostingFinancialEvidenceSigningPayload,
} from "../src/hosting-financial-evidence.js";
import { isJsonString } from "../src/json.js";

const dispose: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	while (dispose.length) await dispose.pop()?.();
});
const hash = (character: string) => `sha256:${character.repeat(64)}`;
async function fixture() {
	const keys = generateKeyPairSync("ed25519");
	const dataDir = mkdtempSync(join(tmpdir(), "hosting-financial-evidence-"));
	dispose.push(() => rmSync(dataDir, { recursive: true, force: true }));
	const binding = create(HostingFinancialResourceBindingSchema, {
		artifactId: hash("a"),
		resourceName: "app",
		productId: "provider.service/v1",
		resourceId: "immutable-app-1",
		physicalId: "native-app-123",
		artifactDigest: hash("b"),
	});
	const request: HostingOperationRequest = {
		plan: create(HostingTransitionPlanSchema, {
			tenantId: "tenant",
			sourcePlanId: hash("c"),
			targetPlanId: binding.artifactId,
			planDigest: hash("d"),
			commitment: { currency: "USD" },
		}),
		operation: {
			$typeName: "hobo.cloud.hosting.v1.HostingTransitionOperation",
			operationId: "transition/retire/1",
			operationDigest: hash("e"),
			action: HostingTransitionAction.RETIRE,
			startedAtMs: 900,
			deadlineAtMs: 100000,
			observationAttempts: 0,
			nextObservationAtMs: 0,
			mutationDispatched: true,
			mutationResumes: 0,
		},
		reservationId: "hold-1",
		fenceToken: 1n,
		signal: new AbortController().signal,
	};
	const lifecycle = {
		tenantId: "tenant",
		providerId: "provider",
		providerAccountId: "account",
		productId: binding.productId,
		resourceId: binding.resourceId,
		physicalId: binding.physicalId,
		operationId: request.operation.operationId,
		status: "absent",
		observedAtMs: 950,
		evidenceRef: "native://operation/123",
		artifactDigest: "",
		operationTerminal: true,
		billable: false,
		healthy: false,
		usageFinal: true,
		settledMicros: 0,
		usageEvidenceRef: "billing://closed/123",
	};
	const liability = {
		resourceName: "app",
		providerId: "provider",
		providerAccountId: "account",
		artifactDigest: binding.artifactDigest,
		mode: "native-finite-term",
		evidenceRef: "billing://prepaid/123",
		expiresAtMs: 90000,
		maximumMicros: 5,
	};
	let nowMs = 1000;
	let claims = create(HostingFinancialEvidenceClaimsSchema, {
		schemaVersion: "hobo.hosting-financial-evidence/v1",
		proofId: "proof-1",
		issuerId: "billing-integration",
		keyId: "key-1",
		tenantId: "tenant",
		providerId: "provider",
		providerAccountId: "account",
		operationId: request.operation.operationId,
		currency: "USD",
		operationDigest: request.operation.operationDigest,
		planDigest: request.plan.planDigest,
		issuedAtMs: 950,
		expiresAtMs: 5000,
		lifecycles: [{ binding, observationJson: canonicalJson(lifecycle) }],
		liabilities: [
			{ binding, liabilityJson: canonicalJson(liability), finalized: true },
		],
	});
	function encode(value = claims, key = keys.privateKey) {
		return toJson(
			HostingFinancialEvidenceAttestationSchema,
			create(HostingFinancialEvidenceAttestationSchema, {
				claims: value,
				signature: `ed25519:${sign(null, Buffer.from(hostingFinancialEvidenceSigningPayload(value)), key).toString("base64url")}`,
			}),
		);
	}
	let responseBody = JSON.stringify(encode()),
		status = 200;
	let expireDuringRead = false;
	const queries: string[] = [];
	const server = createServer((incoming, response) => {
		let query = "";
		incoming.setEncoding("utf8");
		incoming.on("data", (chunk) => {
			query += chunk;
		});
		incoming.on("end", () => {
			if (expireDuringRead) nowMs = 5000;
			queries.push(query);
			response.writeHead(status, { "content-type": "application/json" });
			response.end(responseBody);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	dispose.push(
		() =>
			new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			),
	);
	const address = server.address();
	if (!address || isJsonString(address))
		throw new Error("missing test HTTP address");
	const transport = createBoundedFetchTransport({
		fetchImpl: globalThis.fetch,
	});
	function connect(
		resources: readonly HostingFinancialResourceScope[] = [binding],
	) {
		const store = createRuntimeLocalEventStore({
			dataDir,
			clock: createManualClock("2026-10-30T00:00:00Z"),
		});
		dispose.push(() => store.close());
		const reader = createHostingFinancialEvidenceReader({
			store,
			tenantId: "tenant",
			actor: { kind: "service", id: "worker" },
			fenceToken: 1n,
			transport,
			sources: [
				{
					issuerId: "billing-integration",
					keyId: "key-1",
					publicKey: keys.publicKey,
					tenantId: "tenant",
					providerId: "provider",
					providerAccountId: "account",
					currency: "USD",
					endpoint: `http://127.0.0.1:${address.port}/signed-evidence`,
					resources,
				},
			],
			nowMs: () => nowMs,
			allowInsecureLoopback: true,
		});
		return { reader, store };
	}
	function publish(
		change: (next: HostingFinancialEvidenceClaims) => void,
		options: { signWithOtherKey?: boolean } = {},
	) {
		const next = structuredClone(claims);
		change(next);
		claims = next;
		responseBody = JSON.stringify(
			encode(
				claims,
				options.signWithOtherKey
					? generateKeyPairSync("ed25519").privateKey
					: keys.privateKey,
			),
		);
	}
	const input = {
		request,
		node: {
			name: "app",
			provider: "provider",
			port: "compute",
			productId: binding.productId,
			deps: [],
		},
		artifactId: binding.artifactId,
		resourceId: binding.resourceId,
		physicalId: binding.physicalId,
		nowMs: 1000,
		transport,
		context: {
			tenantId: "tenant",
			providerId: "provider",
			providerAccountId: "account",
			productId: binding.productId,
			resourceId: binding.resourceId,
			physicalId: binding.physicalId,
			operationId: request.operation.operationId,
			artifactDigest: binding.artifactDigest,
			nowMs: 1000,
			maxAgeMs: 60000,
		},
	};
	return {
		connect,
		publish,
		input,
		queries,
		request,
		lifecycle,
		liability,
		binding,
		setTime: (value: number) => {
			nowMs = value;
		},
		setStatus: (value: number) => {
			status = value;
		},
		setBody: (value: string) => {
			responseBody = value;
		},
		encoded: () => encode(),
		expireDuringRead: () => {
			expireDuringRead = true;
		},
	};
}
describe("independently signed durable financial evidence", () => {
	it("requires complete signed coverage before exposing two resources on one billing account", async () => {
		const f = await fixture(),
			second = create(HostingFinancialResourceBindingSchema, {
				...f.binding,
				resourceName: "db",
				productId: "provider.database/v1",
				resourceId: "immutable-db-1",
				physicalId: "native-db-456",
			}),
			a = f.connect([f.binding, second]);
		await expect(a.reader.billing.observe(f.request)).rejects.toThrow(
			/every configured/,
		);
		f.publish((next) => {
			next.proofId = "proof-2";
			next.issuedAtMs = 960;
			next.lifecycles.push({
				$typeName:
					"hobo.hosting.financial.v1.HostingFinancialLifecycleEvidence",
				binding: second,
				observationJson: canonicalJson({
					...f.lifecycle,
					productId: second.productId,
					resourceId: second.resourceId,
					physicalId: second.physicalId,
					observedAtMs: 960,
					settledMicros: 7,
				}),
			});
		});
		const rows = await a.reader.billing.observe(f.request);
		expect(
			rows.map((row) => [row.resourceId, row.settledMicros, row.usageFinal]),
		).toEqual([
			[f.binding.resourceId, 0, true],
			[second.resourceId, 7, true],
		]);
	});
	it("deduplicates a shared native resource across source and target graph bindings", async () => {
		const f = await fixture(),
			shared = create(HostingFinancialResourceBindingSchema, {
				...f.binding,
				artifactId: f.request.plan.sourcePlanId,
			});
		f.publish((next) => {
			next.lifecycles.push({
				$typeName:
					"hobo.hosting.financial.v1.HostingFinancialLifecycleEvidence",
				binding: shared,
				observationJson: canonicalJson(f.lifecycle),
			});
		});
		const a = f.connect([f.binding, shared]);
		expect(await a.reader.billing.observe(f.request)).toHaveLength(1);
	});
	it("rejects conflicting charges or finality for aliases of the same native resource", async () => {
		for (const changes of [{ settledMicros: 9 }, { usageFinal: false }]) {
			const f = await fixture(),
				shared = create(HostingFinancialResourceBindingSchema, {
					...f.binding,
					artifactId: f.request.plan.sourcePlanId,
				});
			f.publish((next) => {
				next.lifecycles.push({
					$typeName:
						"hobo.hosting.financial.v1.HostingFinancialLifecycleEvidence",
					binding: shared,
					observationJson: canonicalJson({ ...f.lifecycle, ...changes }),
				});
			});
			await expect(
				f.connect([f.binding, shared]).reader.billing.observe(f.request),
			).rejects.toThrow(/conflicting/);
		}
	});
	it("converges concurrent proof reads through independent SQLite connections", async () => {
		const f = await fixture(),
			a = f.connect(),
			b = f.connect();
		const rows = await Promise.all([
			a.reader.billing.observe(f.request),
			b.reader.billing.observe(f.request),
		]);
		expect(rows.map((row) => row.length)).toEqual([1, 1]);
		const events = [];
		for await (const event of a.store.readAll()) events.push(event);
		expect(events).toHaveLength(2);
	});
	it("rejects response tampering even when issuer and key IDs are unchanged", async () => {
		const f = await fixture();
		const encoded = f.encoded();
		if (!encoded.claims) throw new Error("missing claims");
		encoded.claims.providerAccountId = "another-account";
		f.setBody(JSON.stringify(encoded));
		await expect(f.connect().reader.billing.observe(f.request)).rejects.toThrow(
			/scope|signature/,
		);
	});
	it("validates the generated signed wire record with actual CUE constraints", async () => {
		const f = await fixture(),
			dir = mkdtempSync(join(tmpdir(), "financial-cue-"));
		dispose.push(() => rmSync(dir, { recursive: true, force: true }));
		const jsonPath = join(dir, "evidence.json"),
			binary = fileURLToPath(
				new URL("../../../.tools/cue/v0.14.0/cue", import.meta.url),
			),
			schema = fileURLToPath(
				new URL(
					"../data-models/hosting_financial_evidence.cue",
					import.meta.url,
				),
			);
		writeFileSync(jsonPath, JSON.stringify(f.encoded()));
		expect(() =>
			execFileSync(
				binary,
				["vet", schema, jsonPath, "-d", "#HostingFinancialEvidenceAttestation"],
				{ stdio: "pipe" },
			),
		).not.toThrow();
		const encoded = f.encoded();
		if (!encoded.claims) throw new Error("missing claims");
		encoded.claims.expiresAtMs = 900;
		writeFileSync(jsonPath, JSON.stringify(encoded));
		expect(() =>
			execFileSync(
				binary,
				["vet", schema, jsonPath, "-d", "#HostingFinancialEvidenceAttestation"],
				{ stdio: "pipe" },
			),
		).toThrow();
	});
	it("rejects credential-bearing metadata before persisting a signed proof", async () => {
		const f = await fixture();
		f.publish((next) => {
			const row = next.lifecycles[0];
			if (!row) throw new Error("missing row");
			row.observationJson = canonicalJson({
				...f.lifecycle,
				usageEvidenceRef: "postgres://user:secret@example.test/db",
			});
		});
		const a = f.connect();
		await expect(a.reader.billing.observe(f.request)).rejects.toThrow(
			/credentials/,
		);
		const events = [];
		for await (const event of a.store.readAll()) events.push(event);
		expect(events).toHaveLength(0);
	});
	it("refuses credential URLs disguised as native resource identities", async () => {
		const f = await fixture();
		f.publish((next) => {
			const row = next.lifecycles[0];
			if (!row?.binding) throw new Error("missing row");
			row.binding.physicalId =
				"rediss://default:secret@redis.example.test:6379";
		});
		const a = f.connect();
		await expect(a.reader.billing.observe(f.request)).rejects.toThrow(
			/credentials/,
		);
		const events = [];
		for await (const event of a.store.readAll()) events.push(event);
		expect(events).toHaveLength(0);
	});
	it("rejects signed currency substitution rather than treating EUR micros as USD", async () => {
		const f = await fixture();
		f.publish((next) => {
			next.currency = "EUR";
		});
		await expect(f.connect().reader.billing.observe(f.request)).rejects.toThrow(
			/scope/,
		);
	});
	it("checks signed proof expiry again after the real HTTP response", async () => {
		const f = await fixture();
		f.expireDuringRead();
		await expect(f.connect().reader.billing.observe(f.request)).rejects.toThrow(
			/stale/,
		);
	});
	it("can reconcile fresh final usage after a mutation deadline and native term have expired", async () => {
		const f = await fixture();
		f.setTime(200000);
		f.publish((next) => {
			next.issuedAtMs = 199950;
			next.expiresAtMs = 204000;
			const row = next.lifecycles[0];
			if (!row) throw new Error("missing row");
			row.observationJson = canonicalJson({
				...f.lifecycle,
				observedAtMs: 199950,
			});
		});
		const rows = await f.connect().reader.billing.observe(f.request);
		expect(rows[0]).toMatchObject({ usageFinal: true, settledMicros: 0 });
	});
	it("cannot revoke a finalized native financial entitlement in a later signed proof", async () => {
		const f = await fixture(),
			a = f.connect();
		await a.reader.observeOperatingLiability(f.input);
		f.publish((next) => {
			next.proofId = "proof-2";
			next.issuedAtMs = 960;
			const row = next.liabilities[0];
			if (!row) throw new Error("missing row");
			row.finalized = false;
		});
		await expect(a.reader.observeOperatingLiability(f.input)).rejects.toThrow(
			/finality regresses/,
		);
	});
	it("reads real HTTP, validates exact native absence and final zero usage, and reopens SQLite idempotently", async () => {
		const f = await fixture(),
			a = f.connect();
		const rows = await a.reader.billing.observe(f.request);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			status: "absent",
			operationTerminal: true,
			usageFinal: true,
			settledMicros: 0,
		});
		expect(await a.reader.observeLifecycle(f.input)).toMatchObject({
			physicalId: f.binding.physicalId,
			status: "absent",
		});
		const b = f.connect();
		expect(await b.reader.observeOperatingLiability(f.input)).toMatchObject({
			liability: f.liability,
			finalized: true,
		});
		const events = [];
		for await (const event of b.store.readAll()) events.push(event);
		expect(events).toHaveLength(2);
		expect(f.queries).toHaveLength(3);
		expect(JSON.parse(f.queries[0] ?? "{}")).toMatchObject({
			operationDigest: f.request.operation.operationDigest,
			providerAccountId: "account",
		});
	});
	it.each([
		"tenantId",
		"providerId",
		"providerAccountId",
		"operationId",
		"operationDigest",
		"planDigest",
	] as const)("rejects signed cross-scope %s", async (field) => {
		const f = await fixture();
		f.publish((next) => {
			next[field] = field.endsWith("Digest") ? hash("f") : "foreign";
		});
		await expect(f.connect().reader.billing.observe(f.request)).rejects.toThrow(
			/scope/,
		);
	});
	it("does not trust an attacker signing key", async () => {
		const f = await fixture();
		f.publish(() => {}, { signWithOtherKey: true });
		await expect(f.connect().reader.billing.observe(f.request)).rejects.toThrow(
			/signature/,
		);
	});
	it("rejects a native physical ID mismatch despite a valid issuer signature", async () => {
		const f = await fixture();
		f.publish((next) => {
			const row = next.lifecycles[0];
			if (!row) throw new Error("missing row");
			row.observationJson = canonicalJson({
				...f.lifecycle,
				physicalId: "foreign-resource",
			});
		});
		await expect(f.connect().reader.observeLifecycle(f.input)).rejects.toThrow(
			/physical/,
		);
	});
	it("preserves the hold when proof is absent, stale, or finality is missing", async () => {
		const f = await fixture(),
			a = f.connect();
		f.setStatus(404);
		expect(await a.reader.billing.observe(f.request)).toEqual([]);
		await expect(a.reader.observeOperatingLiability(f.input)).rejects.toThrow(
			/missing/,
		);
		f.setStatus(200);
		f.setTime(6000);
		await expect(a.reader.billing.observe(f.request)).rejects.toThrow(/stale/);
	});
	it("returns nonfinal native liability without inventing settlement", async () => {
		const f = await fixture();
		f.publish((next) => {
			const row = next.liabilities[0];
			if (!row) throw new Error("missing row");
			row.finalized = false;
			const obs = next.lifecycles[0];
			if (!obs) throw new Error("missing row");
			obs.observationJson = canonicalJson({
				...f.lifecycle,
				usageFinal: false,
				usageEvidenceRef: "",
			});
		});
		const a = f.connect();
		expect((await a.reader.observeOperatingLiability(f.input)).finalized).toBe(
			false,
		);
		expect((await a.reader.billing.observe(f.request))[0]?.usageFinal).toBe(
			false,
		);
	});
	it("rejects altered reuse of a proof ID across independent SQLite connections", async () => {
		const f = await fixture();
		await f.connect().reader.billing.observe(f.request);
		f.publish((next) => {
			next.issuedAtMs = 960;
		});
		await expect(f.connect().reader.billing.observe(f.request)).rejects.toThrow(
			/proof ID/,
		);
	});
	it("rejects older signed observations and revocation of final usage", async () => {
		const f = await fixture(),
			a = f.connect();
		await a.reader.billing.observe(f.request);
		f.publish((next) => {
			next.proofId = "proof-2";
			next.issuedAtMs = 960;
			const row = next.lifecycles[0];
			if (!row) throw new Error("missing row");
			row.observationJson = canonicalJson({
				...f.lifecycle,
				observedAtMs: 940,
			});
		});
		await expect(a.reader.billing.observe(f.request)).rejects.toThrow(
			/regresses/,
		);
		f.publish((next) => {
			next.proofId = "proof-3";
			const row = next.lifecycles[0];
			if (!row) throw new Error("missing row");
			row.observationJson = canonicalJson({
				...f.lifecycle,
				observedAtMs: 970,
				usageFinal: false,
			});
		});
		await expect(a.reader.billing.observe(f.request)).rejects.toThrow(
			/final usage/,
		);
	});
	it("refuses unsafe money and incomplete native finality", async () => {
		for (const changes of [
			{ settledMicros: Number.MAX_SAFE_INTEGER + 1 },
			{ operationTerminal: false },
		]) {
			const f = await fixture();
			f.publish((next) => {
				const row = next.lifecycles[0];
				if (!row) throw new Error("missing row");
				row.observationJson = canonicalJson({ ...f.lifecycle, ...changes });
			});
			await expect(
				f.connect().reader.billing.observe(f.request),
			).rejects.toThrow(/safe|terminal/);
		}
	});
	it("enforces byte bounds and rejects malformed external proof", async () => {
		const f = await fixture(),
			a = f.connect();
		f.setBody("x".repeat(512 * 1024 + 1));
		await expect(a.reader.billing.observe(f.request)).rejects.toThrow();
		f.setBody("{}");
		await expect(a.reader.billing.observe(f.request)).rejects.toThrow(
			/claims missing/,
		);
	});
});
