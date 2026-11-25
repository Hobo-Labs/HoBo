import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
	CampManagement,
	CampSetRecordSchema,
	type CdContext,
	ReconcilerMode,
} from "@hobo/cd";
import { CredentialRequestSchema } from "@hobo/fleet";
import {
	agentKeyFromJwk,
	generateReconcilerKeys,
	inProcessDeliveryFleet,
	reconcilerEnrollment,
} from "@hobo/cd/agent";
import { parseTenantId } from "@hobo/core";
import {
	ApprovalMode,
	CoordinationMode,
	FleetRecordSchema,
	parseFleetId,
	parseMemberId,
	type VerifiedToken,
} from "@hobo/fleet";
import { mintDpopProof } from "@hobo/fleet/keys";
import { createTestAuthority } from "@hobo/fleet/testing";
import {
	type CdIssuerSigningKey,
	type CdIssuerWinner,
	openCdIssuer,
	type PrivateIssuerCandidates,
	type PrivateIssuerJournal,
	prepareCdIssuer,
} from "@hobo/hobo-cd";
import { describe, expect, it, vi } from "vitest";
import { openCdRuntime } from "../src/cd-runtime.js";
import { startCdServer } from "../src/cd-serve.js";
import { openCdStore } from "../src/cd-store.js";
import { injectedCdSvidIssuer } from "../src/cd-svid-issuer.js";
import { campIdOf, staticTopologyReader } from "../src/cd-topology.js";

const origin = "https://cd.fixture.invalid";
const fixtureFleetOrigin = "https://authority.fleet.test";
const fixtureFleetId = parseFleetId("fixture-fleet");
const fixtureTenant = parseTenantId("test");

async function fixtureDeliveryFleet(now = () => Date.now()) {
	const composed = await createTestAuthority(now);
	const station: VerifiedToken = {
		kind: "person",
		principal: { kind: "service", id: "cd-station" },
		tenant: fixtureTenant,
		tags: ["fleet-admin"],
		jkt: "cd-station",
		expiresAtMs: Number.MAX_SAFE_INTEGER,
	};
	const defined = await composed.authority.defineFleet(
		create(FleetRecordSchema, {
			fleetId: fixtureFleetId,
			tenant: fixtureTenant,
			owner: "service:cd-station",
			coordination: CoordinationMode.MANY_ACTIVE,
			policy: { approval: ApprovalMode.SINGLE },
		}),
		station,
	);
	if (!defined.ok) throw new Error(defined.error.message);
	return inProcessDeliveryFleet({
		authority: composed.authority,
		tenant: fixtureTenant,
		fleet: fixtureFleetId,
		origin: fixtureFleetOrigin,
		station,
	});
}

function authorities() {
	const values = new Map<string, string>();
	let next = 0;
	let winner: CdIssuerWinner | undefined;
	const candidates: PrivateIssuerCandidates = {
		async createCandidate(material) {
			const reference = `fixture-candidate-${++next}`;
			values.set(reference, material);
			return reference;
		},
		async readCandidate(reference) {
			return values.get(reference);
		},
	};
	const journal: PrivateIssuerJournal = {
		async readWinner() {
			return winner;
		},
		async claimWinner(candidate) {
			if (winner) return "exists";
			winner = candidate;
			return "created";
		},
	};
	return { candidates, journal };
}

function certificate(home: string) {
	const key = join(home, "tls-key.pem");
	const cert = join(home, "tls-cert.pem");
	execFileSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-days",
			"1",
			"-subj",
			"/CN=127.0.0.1",
			"-addext",
			"subjectAltName=IP:127.0.0.1",
			"-keyout",
			key,
			"-out",
			cert,
		],
		{ stdio: "ignore" },
	);
	return { key: readFileSync(key, "utf8"), cert: readFileSync(cert, "utf8") };
}

async function response(
	port: number,
	cert: string,
	path: string,
	authorized = false,
) {
	return await new Promise<{ status: number; body: string }>(
		(resolve, reject) => {
			const req = httpsRequest(
				{
					host: "127.0.0.1",
					port,
					path,
					ca: cert,
					headers: authorized ? { "x-fixture-operator": "allow" } : {},
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (chunk: Buffer) => chunks.push(chunk));
					res.on("end", () =>
						resolve({
							status: res.statusCode ?? 0,
							body: Buffer.concat(chunks).toString(),
						}),
					);
					res.on("error", reject);
				},
			);
			req.on("error", reject);
			req.end();
		},
	);
}

async function status(
	port: number,
	cert: string,
	path: string,
	authorized = false,
) {
	return (await response(port, cert, path, authorized)).status;
}

describe("injected CD SVID issuer", () => {
	it("does not fall back to another issuer when the injected authority fails", async () => {
		const readSecret = vi.fn(async () => "unused synthetic value");
		const openSigningKey = vi.fn(async () => {
			throw new Error("synthetic-private-provider.invalid secret material");
		});
		const opened = await openCdRuntime({
			env: {},
			home: "/unused",
			cwd: "/unused",
			simulate: false,
			publicOrigin: origin,
			openSigningKey,
			readSecret,
		});
		expect(opened.ok).toBe(false);
		if (opened.ok) await opened.value.close();
		else {
			expect(opened.reasons[0]?.code).toBe("cd-svid-issuer-unavailable");
			expect(JSON.stringify(opened.reasons)).not.toContain(
				"synthetic-private-provider.invalid",
			);
		}
		expect(openSigningKey).toHaveBeenCalledOnce();
		expect(readSecret).not.toHaveBeenCalled();
	});

	it("rejects an injected signing authority without a public origin", async () => {
		const home = mkdtempSync(join(tmpdir(), "hobo-cd-no-origin-"));
		const openSigningKey = vi.fn(async () => {
			throw new Error("unexpected callback");
		});
		try {
			const opened = await openCdRuntime({
				env: {},
				home,
				cwd: home,
				simulate: true,
				openSigningKey,
			});
			if (opened.ok) await opened.value.close();
			expect(opened.ok).toBe(false);
			expect(openSigningKey).not.toHaveBeenCalled();
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("closes the injected handle when the runtime fails to open its journal", async () => {
		const authority = authorities();
		const key = await prepareCdIssuer({ origin, ...authority });
		const close = vi.fn(() => key.close());
		try {
			const opened = await openCdRuntime({
				env: {},
				home: "/unused",
				cwd: "/unused",
				simulate: false,
				publicOrigin: origin,
				openSigningKey: async () => ({ ...key, close }),
				openStore: async () => {
					throw new Error("synthetic journal failure");
				},
			});
			expect(opened.ok).toBe(false);
			if (opened.ok) await opened.value.close();
			expect(close).toHaveBeenCalledOnce();
			expect(key.available()).toBe(false);
		} finally {
			key.close();
		}
	});

	it("redacts journal open failures and closes the signing handle", async () => {
		const key = await prepareCdIssuer({ origin, ...authorities() });
		const opened = await openCdRuntime({
			env: {},
			home: "/unused",
			cwd: "/unused",
			simulate: false,
			publicOrigin: origin,
			openSigningKey: async () => key,
			openStore: async () => {
				throw new Error("synthetic-private-journal.invalid connection");
			},
		});
		expect(opened.ok).toBe(false);
		if (opened.ok) await opened.value.close();
		else {
			expect(opened.reasons[0]?.code).toBe("cd-store-unavailable");
			expect(JSON.stringify(opened.reasons)).not.toContain(
				"synthetic-private-journal.invalid",
			);
		}
		expect(key.available()).toBe(false);
	});

	it("closes the owned journal and signing handle when composition throws", async () => {
		const key = await prepareCdIssuer({ origin, ...authorities() });
		const store = await openCdStore({ backend: "memory" }, { now: Date.now });
		const closeStore = vi.fn(() => store.close());
		const opened = await openCdRuntime({
			env: {},
			home: "/unused",
			cwd: "/unused",
			simulate: false,
			publicOrigin: origin,
			openSigningKey: async () => key,
			openStore: async () => ({ ...store, close: closeStore }),
			realizers: {
				get conductor() {
					throw new Error("synthetic-private-provider.invalid realizer");
				},
			},
		});
		expect(opened.ok).toBe(false);
		if (opened.ok) await opened.value.close();
		else
			expect(JSON.stringify(opened.reasons)).not.toContain(
				"synthetic-private-provider.invalid",
			);
		expect(closeStore).toHaveBeenCalledOnce();
		expect(key.available()).toBe(false);
	});

	it("leaves a caller-owned journal open when composition throws", async () => {
		const key = await prepareCdIssuer({ origin, ...authorities() });
		const journal = await openCdStore({ backend: "memory" }, { now: Date.now });
		try {
			const opened = await openCdRuntime({
				env: {},
				home: "/unused",
				cwd: "/unused",
				simulate: false,
				publicOrigin: origin,
				openSigningKey: async () => key,
				store: journal.store,
				realizers: {
					get conductor() {
						throw new Error("synthetic composition failure");
					},
				},
			});
			expect(opened.ok).toBe(false);
			if (opened.ok) await opened.value.close();
			for await (const event of journal.store.read("fixture-stream")) {
				expect(event).toBeDefined();
			}
			expect(key.available()).toBe(false);
		} finally {
			key.close();
			await journal.close();
		}
	});

	it("closes a handle whose public key does not match its declared fingerprint", async () => {
		const authority = authorities();
		const key = await prepareCdIssuer({ origin, ...authority });
		const close = vi.fn(() => key.close());
		try {
			const opened = await openCdRuntime({
				env: {},
				home: "/unused",
				cwd: "/unused",
				simulate: false,
				publicOrigin: origin,
				openSigningKey: async () => ({ ...key, keyId: "0".repeat(64), close }),
			});
			expect(opened.ok).toBe(false);
			if (opened.ok) await opened.value.close();
			expect(close).toHaveBeenCalledOnce();
			expect(key.available()).toBe(false);
		} finally {
			key.close();
		}
	});

	it("rejects a signing handle whose key identity changes during startup", async () => {
		const key = await prepareCdIssuer({ origin, ...authorities() });
		const close = vi.fn(() => key.close());
		let reads = 0;
		try {
			const opened = await openCdRuntime({
				env: {},
				home: "/unused",
				cwd: "/unused",
				simulate: false,
				publicOrigin: origin,
				openSigningKey: async () => ({
					...key,
					get keyId() {
						return ++reads === 1 ? key.keyId : "0".repeat(64);
					},
					close,
				}),
			});
			expect(opened.ok).toBe(false);
			if (opened.ok) await opened.value.close();
			expect(close).toHaveBeenCalledOnce();
			expect(key.available()).toBe(false);
		} finally {
			key.close();
		}
	});

	it("redacts provider signing failures", async () => {
		const key = await prepareCdIssuer({ origin, ...authorities() });
		const issuer = injectedCdSvidIssuer(
			{
				...key,
				sign() {
					throw new Error("synthetic-private-provider.invalid secret material");
				},
			},
			origin,
		);
		try {
			expect(() => issuer.issuer.kms.sign(key.keyId, "fixture")).toThrow(
				"CD signing key unavailable",
			);
		} finally {
			issuer.close();
		}
	});

	it("closes the journal if signing-handle cleanup fails", async () => {
		const key = await prepareCdIssuer({ origin, ...authorities() });
		const store = await openCdStore({ backend: "memory" }, { now: Date.now });
		const closeStore = vi.fn(() => store.close());
		const opened = await openCdRuntime({
			env: {},
			home: "/unused",
			cwd: "/unused",
			simulate: false,
			publicOrigin: origin,
			openSigningKey: async () => ({
				...key,
				close() {
					key.close();
					throw new Error("synthetic-private-provider.invalid cleanup");
				},
			}),
			openStore: async () => ({ ...store, close: closeStore }),
		});
		expect(opened.ok).toBe(true);
		if (!opened.ok) {
			await store.close();
			return;
		}
		await expect(opened.value.close()).rejects.toThrow(
			"CD signing key cleanup failed",
		);
		expect(closeStore).toHaveBeenCalledOnce();
		expect(key.available()).toBe(false);
	});

	it("redacts journal cleanup failures and closes the signing handle", async () => {
		const key = await prepareCdIssuer({ origin, ...authorities() });
		const store = await openCdStore({ backend: "memory" }, { now: Date.now });
		const closeStore = vi.fn(async () => {
			await store.close();
			throw new Error("synthetic-private-journal.invalid cleanup");
		});
		const opened = await openCdRuntime({
			env: {},
			home: "/unused",
			cwd: "/unused",
			simulate: false,
			publicOrigin: origin,
			openSigningKey: async () => key,
			openStore: async () => ({ ...store, close: closeStore }),
		});
		expect(opened.ok).toBe(true);
		if (!opened.ok) {
			await store.close();
			return;
		}
		await expect(opened.value.close()).rejects.toThrow(
			"CD journal cleanup failed",
		);
		expect(closeStore).toHaveBeenCalledOnce();
		expect(key.available()).toBe(false);
	});

	it("redacts journal cleanup failures during refused startup", async () => {
		const key = await prepareCdIssuer({ origin, ...authorities() });
		const store = await openCdStore({ backend: "memory" }, { now: Date.now });
		const closeStore = vi.fn(async () => {
			await store.close();
			throw new Error("synthetic-private-journal.invalid cleanup");
		});
		try {
			await expect(
				openCdRuntime({
					env: { HOBO_CD_KUBE_FLEET: "missing-fixture.json" },
					home: "/unused",
					cwd: "/unused",
					simulate: false,
					publicOrigin: origin,
					openSigningKey: async () => key,
					openStore: async () => ({ ...store, close: closeStore }),
				}),
			).rejects.toThrow("CD journal cleanup failed");
			expect(closeStore).toHaveBeenCalledOnce();
			expect(key.available()).toBe(false);
		} finally {
			key.close();
		}
	});

	it("withdraws public readiness and agent feed if the signing handle becomes unavailable", async () => {
		const home = mkdtempSync(join(tmpdir(), "hobo-cd-signing-health-"));
		const tls = certificate(home);
		const key = await prepareCdIssuer({ origin, ...authorities() });
		let state: "ready" | "unavailable" | "error" = "ready";
		try {
			const opened = await openCdRuntime({
				env: {},
				home,
				cwd: home,
				simulate: false,
				publicOrigin: origin,
				openSigningKey: async () => ({
					...key,
					available() {
						if (state === "error")
							throw new Error("synthetic-private-provider.invalid");
						return state === "ready" && key.available();
					},
				}),
			});
			expect(opened.ok).toBe(true);
			if (!opened.ok) return;
			const server = await startCdServer({
				runtime: opened.value,
				host: "127.0.0.1",
				port: 0,
				log: () => {},
				access: {
					kind: "authenticated",
					publicOrigin: origin,
					tls,
					authorizeOperator: async () => true,
				},
			});
			try {
				expect(await status(server.port, tls.cert, "/readyz")).toBe(200);
				for (const next of ["unavailable", "error"] as const) {
					state = next;
					expect(await status(server.port, tls.cert, "/readyz")).toBe(503);
					const readiness = await response(
						server.port,
						tls.cert,
						"/v1/cd/ready",
						true,
					);
					expect(readiness.status).toBe(503);
					expect(readiness.body).not.toContain(
						"synthetic-private-provider.invalid",
					);
					expect(await status(server.port, tls.cert, "/v1/cd/feed")).toBe(503);
				}
				state = "ready";
				expect(await status(server.port, tls.cert, "/readyz")).toBe(200);
			} finally {
				await server.close();
			}
		} finally {
			key.close();
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("signs through the elected handle and verifies after the runtime restarts", async () => {
		const home = mkdtempSync(join(tmpdir(), "hobo-cd-signing-fixture-"));
		const tls = certificate(home);
		const authority = authorities();
		const prepared = await prepareCdIssuer({ origin, ...authority });
		const expectedKey = prepared.keyId;
		prepared.close();
		const openedKeys: CdIssuerSigningKey[] = [];
		const sign = vi.fn(
			(key: CdIssuerSigningKey, payload: string | Uint8Array) =>
				key.sign(payload),
		);
		const openSigningKey = vi.fn(async (requestedOrigin: string) => {
			expect(requestedOrigin).toBe(origin);
			const key = await openCdIssuer({ origin: requestedOrigin, ...authority });
			openedKeys.push(key);
			return {
				...key,
				sign: (payload: string | Uint8Array) => sign(key, payload),
			};
		});
		const readSecret = vi.fn(async () => undefined);
		const fleet = await fixtureDeliveryFleet();
		const campId = campIdOf("fixture", "prod");
		const topology = staticTopologyReader([
			{
				campId,
				yardId: "fixture",
				stationId: "",
				provider: "fixture",
				regions: [],
				envType: "production",
				labels: {},
				management: CampManagement.OBSERVE_ONLY,
			},
		]);
		const open = () =>
			openCdRuntime({
				env: {},
				home,
				cwd: home,
				simulate: false,
				publicOrigin: origin,
				openSigningKey,
				readSecret,
				topology: [topology],
				fleet,
			});
		const access = {
			kind: "authenticated" as const,
			publicOrigin: origin,
			tls,
			async authorizeOperator(request: {
				headers: Readonly<Record<string, string>>;
			}) {
				return request.headers["x-fixture-operator"] === "allow";
			},
		};
		try {
			const first = await open();
			expect(first.ok).toBe(true);
			if (!first.ok) return;
			expect(first.value.issuerKeyId).toBe(expectedKey);
			const server = await startCdServer({
				runtime: first.value,
				host: "127.0.0.1",
				port: 0,
				log: () => {},
				access,
			});
			let svid = "";
			const reconcilerKeys = generateReconcilerKeys();
			const agentSign = agentKeyFromJwk(reconcilerKeys.sign);
			try {
				expect(await status(server.port, tls.cert, "/readyz")).toBe(200);
				expect(await status(server.port, tls.cert, "/v1/cd/camps")).toBe(401);
				expect(await status(server.port, tls.cert, "/v1/cd/camps", true)).toBe(
					200,
				);
				const operator = (id: string): CdContext => ({
					tenant: first.value.config.tenant,
					principal: { kind: "user", id },
					now: () => Date.now(),
				});
				const set = await first.value.cd.inventory.defineSet(
					create(CampSetRecordSchema, {
						name: "fixture-fleet",
						campIds: [campId],
					}),
					operator("fixture-a"),
				);
				expect(set.ok).toBe(true);
				const issued = await first.value.cd.enrollment.issueToken(
					{
						campSet: "fixture-fleet",
						campIds: [campId],
						mode: ReconcilerMode.AGENT,
						ttlMs: 60_000,
					},
					operator("fixture-a"),
				);
				if (!issued.ok) throw new Error(issued.reasons[0]?.code);
				const agent = await reconcilerEnrollment({
					keys: reconcilerKeys,
					token: issued.value.token,
					tenant: fixtureTenant,
					fleet: fixtureFleetId,
					origin: fixtureFleetOrigin,
					nowMs: Date.now(),
					agentVersion: "1.0.0",
				});
				const enrolled = await first.value.cd.enrollment.enroll(
					{
						request: agent.request,
						dpopProof: agent.dpopProof,
						campIds: [campId],
					},
					operator("fixture-a"),
				);
				if (!enrolled.ok) throw new Error(enrolled.reasons[0]?.code);
				const id = enrolled.value.reconciler.reconcilerId;
				expect(
					(
						await first.value.cd.enrollment.approveKey(
							id,
							operator("fixture-a"),
						)
					).ok,
				).toBe(true);
				expect(
					(
						await first.value.cd.enrollment.accept(
							{ reconcilerId: id, campIds: [campId] },
							operator("fixture-b"),
						)
					).ok,
				).toBe(true);
				const memberId = parseMemberId(id);
				const credentialUrl = `${fixtureFleetOrigin}/v1/fleet/members/${memberId}/credentials`;
				const refreshed = await first.value.cd.enrollment.refresh(
					{
						memberId,
						request: create(CredentialRequestSchema, {
							generation: 0,
							refreshNonce: randomBytes(16),
							agentVersion: "1.0.0",
						}),
						dpopProof: await mintDpopProof(
							agentSign.signer,
							agentSign.publicJwk,
							{
							htm: "POST",
							htu: credentialUrl,
							nowMs: Date.now(),
						}),
					},
					operator("fixture-a"),
				);
				if (!refreshed.ok)
					throw new Error(
						refreshed.reasons.map((r) => `${r.code}: ${r.message}`).join("; "),
					);
				svid = refreshed.value.svid;
			} finally {
				await server.close();
			}
			expect(openedKeys[0]?.available()).toBe(false);
			const restarted = await open();
			expect(restarted.ok).toBe(true);
			if (!restarted.ok) return;
			try {
				expect(restarted.value.issuerKeyId).toBe(expectedKey);
				const proof = await mintDpopProof(
					agentSign.signer,
					agentSign.publicJwk,
					{
					htm: "GET",
					htu: `${origin}/v1/cd/feed`,
					nowMs: Date.now(),
					accessToken: svid,
				});
				const verified = await restarted.value.cd.enrollment.verify({
					method: "GET",
					path: "/v1/cd/feed",
					headers: { authorization: `DPoP ${svid}`, dpop: proof },
					body: new Uint8Array(),
				});
				expect(verified.ok).toBe(true);
			} finally {
				await restarted.value.close();
			}
			expect(openedKeys[1]?.available()).toBe(false);
			expect(openSigningKey).toHaveBeenCalledTimes(2);
			expect(readSecret).not.toHaveBeenCalled();
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
