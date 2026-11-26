import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
	createManualClock,
	createRuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";
import {
	HostingCredentialScopeChallengeSchema,
	HostingCredentialScopeRequestSchema,
} from "../src/_generated/hosting_credential_scope_pb.js";
import {
	createDurableHostingCredentialScopeReplayStore,
	createHostingCredentialScopeIssuer,
	createHostingCredentialScopeVerifier,
	createVerifiedHostingCredentialLease,
	hashHostingCredentialMaterial,
} from "../src/hosting-credential-scope.js";

const dispose: (() => void)[] = [];
afterEach(() => {
	while (dispose.length) dispose.pop()?.();
});

function fixture() {
	const dataDir = mkdtempSync(join(tmpdir(), "hosting-credential-scope-"));
	dispose.push(() => rmSync(dataDir, { recursive: true, force: true }));
	const keys = generateKeyPairSync("ed25519");
	const identity = {
		tenantId: "tenant",
		providerId: "aws",
		providerAccountId: "billing-account",
		nativeAccountRef: "aws:123456789012",
	};
	const request = {
		tenantId: identity.tenantId,
		providerId: identity.providerId,
		providerAccountId: identity.providerAccountId,
		credentialRef: "vault://hosting/aws",
		operationId: "transition/prepare/1",
		nowMs: 1000,
	};
	const mutableMaterial = {
		accessKeyId: "temporary-test-key",
		secretAccessKey: "temporary-test-secret",
		nested: { sessionToken: "temporary-session" },
	};
	const issuer = createHostingCredentialScopeIssuer({
		issuerId: "trusted-hosting-issuer",
		keyId: "issuer-key-v1",
		privateKey: keys.privateKey,
		bindings: [
			{
				identity,
				credentialRef: request.credentialRef,
				credentialVersion: "version-1",
				credential: mutableMaterial,
				evidenceRef: "inventory://enrollment/account-123",
				observedAtMs: 900,
				validUntilMs: 100_000,
			},
		],
	});
	const time = { nowMs: 1000 };
	function connect() {
		const store = createRuntimeLocalEventStore({
			dataDir,
			clock: createManualClock("2026-10-29T12:00:00Z"),
		});
		dispose.push(() => store.close());
		const replayStore = createDurableHostingCredentialScopeReplayStore({
			store,
			tenantId: identity.tenantId,
			actor: { kind: "service", id: "hosting-worker" },
			fenceToken: 1n,
		});
		const verifier = createHostingCredentialScopeVerifier({
			trust: [
				{
					issuerId: "trusted-hosting-issuer",
					keyId: "issuer-key-v1",
					publicKey: keys.publicKey,
					identities: [identity],
				},
			],
			replayStore,
			nowMs: () => time.nowMs,
		});
		return { store, verifier, replayStore };
	}
	const challenge = create(HostingCredentialScopeChallengeSchema, {
		request: create(HostingCredentialScopeRequestSchema, request),
		challengeId: "single-use-challenge",
	});
	const expected = {
		credentialVersion: "version-1",
		credentialDigest: hashHostingCredentialMaterial(mutableMaterial),
	};
	return {
		connect,
		issuer,
		challenge,
		expected,
		request,
		mutableMaterial,
		time,
		identity,
		keys,
	};
}

describe("production hosting credential custody and account proof", () => {
	it("captures a version-pinned deep-frozen credential once despite later rotation", async () => {
		const fx = fixture();
		let resolutions = 0;
		const lease = await createVerifiedHostingCredentialLease({
			request: fx.request,
			resolveCredential: async () => {
				resolutions++;
				return { version: "version-1", material: fx.mutableMaterial };
			},
			attest: fx.issuer.attest,
			verifier: fx.connect().verifier,
		});
		fx.mutableMaterial.secretAccessKey = "rotated-after-verification";
		fx.mutableMaterial.nested.sessionToken = "rotated-session";
		expect(await lease.resolveCredential()).toEqual({
			accessKeyId: "temporary-test-key",
			secretAccessKey: "temporary-test-secret",
			nested: { sessionToken: "temporary-session" },
		});
		expect(Object.isFrozen(await lease.resolveCredential())).toBe(true);
		expect(Object.isFrozen((await lease.resolveCredential()).nested)).toBe(
			true,
		);
		expect(resolutions).toBe(1);
		expect(lease.credentialRef).toBe(
			"vault://hosting/aws#hobo-version=version-1",
		);
		fx.time.nowMs = 2000;
		await lease.verifyCredentialScope({
			...fx.request,
			credentialRef: lease.credentialRef,
			nowMs: 2000,
		});
		await lease.verifyCredentialScope({
			...fx.request,
			credentialRef: lease.credentialRef,
			operationId: "transition/shift/1",
			nowMs: 2000,
		});
		await expect(
			lease.verifyCredentialScope({
				...fx.request,
				credentialRef: lease.credentialRef,
				providerAccountId: "other",
			}),
		).rejects.toThrow("operation scope");
		await expect(
			lease.verifyCredentialScope({
				...fx.request,
				credentialRef: lease.credentialRef,
				nowMs: 100_000,
			}),
		).rejects.toThrow("stale");
	});

	it("rejects a rotated material snapshot before provider IO", async () => {
		const fx = fixture();
		fx.mutableMaterial.secretAccessKey = "rotated-before-verification";
		await expect(
			createVerifiedHostingCredentialLease({
				request: fx.request,
				resolveCredential: async () => ({
					version: "version-1",
					material: fx.mutableMaterial,
				}),
				attest: fx.issuer.attest,
				verifier: fx.connect().verifier,
			}),
		).rejects.toThrow("material");
	});

	it("refuses re-enrolling different material under the same credential version after restart", async () => {
		const fx = fixture();
		const initial = fx.connect();
		await initial.verifier.verify({
			...fx.expected,
			challenge: fx.challenge,
			attestation: await fx.issuer.attest(fx.challenge),
		});
		const material = {
			...fx.mutableMaterial,
			secretAccessKey: "different-material-under-same-version",
		};
		const changedIssuer = createHostingCredentialScopeIssuer({
			issuerId: "trusted-hosting-issuer",
			keyId: "issuer-key-v1",
			privateKey: fx.keys.privateKey,
			bindings: [
				{
					identity: fx.identity,
					credentialRef: fx.request.credentialRef,
					credentialVersion: "version-1",
					credential: material,
					evidenceRef: "inventory://reenrollment",
					observedAtMs: 900,
					validUntilMs: 100_000,
				},
			],
		});
		await expect(
			createVerifiedHostingCredentialLease({
				request: fx.request,
				resolveCredential: async () => ({ version: "version-1", material }),
				attest: changedIssuer.attest,
				verifier: fx.connect().verifier,
			}),
		).rejects.toThrow("reused with different material");
	});

	it("refuses to sign an unenrolled tenant or account", async () => {
		const fx = fixture();
		fx.challenge.request = create(HostingCredentialScopeRequestSchema, {
			...fx.request,
			tenantId: "foreign-tenant",
		});
		await expect(fx.issuer.attest(fx.challenge)).rejects.toThrow(
			"not uniquely enrolled",
		);
	});

	it("rejects modified claims with a valid-looking signature", async () => {
		const fx = fixture();
		const attestation = structuredClone(await fx.issuer.attest(fx.challenge));
		if (!attestation.claims?.binding)
			throw new Error("fixture missing signed binding");
		attestation.claims.binding.evidenceRef = "inventory://attacker";
		await expect(
			fx.connect().verifier.verify({
				...fx.expected,
				challenge: fx.challenge,
				attestation,
			}),
		).rejects.toThrow("signature");
	});

	it("rejects an attacker's key even when issuer and key names match", async () => {
		const fx = fixture();
		const attacker = generateKeyPairSync("ed25519");
		const attackerIssuer = createHostingCredentialScopeIssuer({
			issuerId: "trusted-hosting-issuer",
			keyId: "issuer-key-v1",
			privateKey: attacker.privateKey,
			bindings: [
				{
					identity: fx.identity,
					credentialRef: fx.request.credentialRef,
					credentialVersion: "version-1",
					credential: fx.mutableMaterial,
					evidenceRef: "inventory://forged",
					observedAtMs: 900,
					validUntilMs: 100_000,
				},
			],
		});
		await expect(
			fx.connect().verifier.verify({
				...fx.expected,
				challenge: fx.challenge,
				attestation: await attackerIssuer.attest(fx.challenge),
			}),
		).rejects.toThrow("signature");
	});

	it("requires the native account to be pinned by the verifier", async () => {
		const fx = fixture();
		const connection = fx.connect();
		const verifier = createHostingCredentialScopeVerifier({
			trust: [
				{
					issuerId: "trusted-hosting-issuer",
					keyId: "issuer-key-v1",
					publicKey: fx.keys.publicKey,
					identities: [
						{ ...fx.identity, nativeAccountRef: "aws:wrong-account" },
					],
				},
			],
			replayStore: connection.replayStore,
			nowMs: () => 1000,
		});
		await expect(
			verifier.verify({
				...fx.expected,
				challenge: fx.challenge,
				attestation: await fx.issuer.attest(fx.challenge),
			}),
		).rejects.toThrow("native account");
	});

	it("consumes a proof only once across independent SQLite connections and reopen", async () => {
		const fx = fixture();
		const input = {
			...fx.expected,
			challenge: fx.challenge,
			attestation: await fx.issuer.attest(fx.challenge),
		};
		const first = fx.connect(),
			second = fx.connect();
		const outcomes = await Promise.allSettled([
			first.verifier.verify(input),
			second.verifier.verify(input),
		]);
		expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
			"fulfilled",
			"rejected",
		]);
		await expect(fx.connect().verifier.verify(input)).rejects.toThrow();
		const persisted = [];
		for await (const event of first.store.readAll())
			persisted.push(event.event.data);
		expect(persisted).toHaveLength(2);
		expect(JSON.stringify(persisted)).not.toContain("temporary-test-secret");
		expect(JSON.stringify(persisted)).not.toContain("sessionToken");
	});

	it("rejects a proof reused for another challenge or operation", async () => {
		const fx = fixture();
		const attestation = structuredClone(await fx.issuer.attest(fx.challenge));
		fx.challenge.challengeId = "different-challenge";
		await expect(
			fx.connect().verifier.verify({
				...fx.expected,
				challenge: fx.challenge,
				attestation,
			}),
		).rejects.toThrow("operation and material");
	});

	it("checks time after attestation IO, rejecting expiration and future clocks", async () => {
		const fx = fixture();
		const attestation = structuredClone(await fx.issuer.attest(fx.challenge));
		fx.time.nowMs = 61_000;
		await expect(
			fx.connect().verifier.verify({
				...fx.expected,
				challenge: fx.challenge,
				attestation,
			}),
		).rejects.toThrow("operation and material");
		fx.time.nowMs = 950;
		await expect(
			fx.connect().verifier.verify({
				...fx.expected,
				challenge: fx.challenge,
				attestation,
			}),
		).rejects.toThrow("operation and material");
	});

	it("does not accept NaN normalized to protobuf defaults", async () => {
		const fx = fixture();
		const attestation = structuredClone(await fx.issuer.attest(fx.challenge));
		if (!attestation.claims?.binding)
			throw new Error("fixture missing binding");
		attestation.claims.binding.observedAtMs = Number.NaN;
		await expect(
			fx.connect().verifier.verify({
				...fx.expected,
				challenge: fx.challenge,
				attestation,
			}),
		).rejects.toThrow("clock");
		expect(() =>
			hashHostingCredentialMaterial({ token: "test", invalid: Number.NaN }),
		).toThrow("finite JSON");
	});

	it("cannot mutate the request through the issuer callback", async () => {
		const fx = fixture();
		await expect(
			createVerifiedHostingCredentialLease({
				request: fx.request,
				resolveCredential: async () => ({
					version: "version-1",
					material: fx.mutableMaterial,
				}),
				attest: async (challenge) => {
					if (!challenge.request) throw new Error("fixture missing request");
					challenge.request.providerAccountId = "foreign";
					return fx.issuer.attest(challenge);
				},
				verifier: fx.connect().verifier,
			}),
		).rejects.toThrow();
	});
});
